/** D-148 § A.9 + § P8 — Server Passport export module.
 *
 *  Three responsibilities:
 *
 *    1. Collect the full identity / network / clients / capabilities /
 *       recovery / key_health bundle from the substrate (each block has
 *       its own provider — passport doesn't know how to enumerate
 *       paired clients or compute key health, but it knows the shape).
 *    2. Project the full bundle into the requested profile via the
 *       `projectServerPassport` helper from contracts (Codex P1 #4
 *       fold — the projection ALSO strips the source signature so the
 *       new signature commits to the projection bytes alone).
 *    3. Sign the projection with `server_identity_key`, emit the
 *       high-assurance audit row + return the signed projection.
 *
 *  The substrate refuses to mint an unsigned passport — every export
 *  goes through the signing path. Verifiers reuse
 *  `verifyServerPassport` (this module) which canonicalizes the same
 *  bytes and Ed25519-verifies against the embedded
 *  `identity.server_public_key`.
 *
 *  Why audit-emit AFTER the projection but BEFORE the signature
 *  appears in storage. The audit row's purpose is to record the
 *  user's INTENT to export — even if signing somehow fails, the
 *  intent is still on the ledger, and the user can re-attempt. The
 *  alternative (audit after sign success) loses the trace when the
 *  signing path fails, leaving a silent gap. The substrate's high-
 *  assurance audit-emission is itself signed (D-148 § A.2.5), so the
 *  passport-export audit row is verifiable on its own.
 */

import { randomUUID } from 'node:crypto';
import {
  canonicalJSONStringify,
  projectServerPassport,
  SERVER_PASSPORT_VERSION,
  type ServerPassport,
  type ServerPassportClientEntry,
  type ServerPassportExportOptions,
  type ServerPassportIdentityBlock,
  type ServerPassportNetworkBlock,
  type ServerPassportImportCommitResult,
  type ServerPassportProfile,
  type ServerPassportProjection,
  type ServerPassportRecoveryBlock,
  type ServerCapabilityProfile,
  type KeyHealthBundle,
  type HandleHistoryEntry,
} from '@recued/contracts';

const SUPPORTED_PASSPORT_VERSIONS: ReadonlyArray<string> = [SERVER_PASSPORT_VERSION] as const;
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import { base64ToBytes } from '@recued/crypto';
import {
  ed25519PublicKeyFingerprint,
  ed25519Sign,
  ed25519Verify,
  type Ed25519Keypair,
} from '../keys/index.js';

// ────────────────────────────────────────────────────────────────
// Block providers (substrate seam)
// ────────────────────────────────────────────────────────────────

/** Substrate seams the passport collector reads through. Each block
 *  has its own provider so callers wire production substrate
 *  (audit-store, broadcast bus, key-health computer) against the
 *  same interface tests pin a pure value to. */
export interface PassportBlockProviders {
  loadIdentity(): Promise<ServerPassportIdentityBlock> | ServerPassportIdentityBlock;
  loadNetwork(): Promise<ServerPassportNetworkBlock> | ServerPassportNetworkBlock;
  loadClients(): Promise<ServerPassportClientEntry[]> | ServerPassportClientEntry[];
  loadCapabilities(): Promise<ServerCapabilityProfile> | ServerCapabilityProfile;
  loadRecovery(): Promise<ServerPassportRecoveryBlock> | ServerPassportRecoveryBlock;
  loadKeyHealth(): Promise<KeyHealthBundle> | KeyHealthBundle;
}

/** Audit emission seam. The passport substrate doesn't construct the
 *  signed activity entry directly — the wrapping audit log
 *  (`createSigningAuditLog`) signs as part of `logActivity` when the
 *  action is in `HIGH_ASSURANCE_AUDIT_KINDS`. The substrate hands the
 *  raw entry shape over, sign + persist happen at the wrapper. */
export interface PassportAuditEmitter {
  log(entry: ActivityEntry): Promise<void> | void;
}

/** Adapter from `AuditLogStore` to the lighter-weight `PassportAuditEmitter`
 *  shape. Production wires `createPassportAuditEmitter(auditLog)` so
 *  the signing wrapper handles `passport.exported` rows. */
export const createPassportAuditEmitter = (
  auditLog: AuditLogStore,
): PassportAuditEmitter => ({
  async log(entry) {
    await auditLog.logActivity(entry);
  },
});

// ────────────────────────────────────────────────────────────────
// Collector + exporter
// ────────────────────────────────────────────────────────────────

export interface CollectFullPassportArgs {
  providers: PassportBlockProviders;
  exported_by_client_id: string;
  reason?: string;
  /** Override clock — used by tests to pin `exported_at`. */
  now?: () => number;
  /** Override id mint — tests pin a stable UUID. */
  mintId?: () => string;
}

/** Collect the full passport bundle from the substrate, populate
 *  metadata fields (version + uuid + exported_at + exported_by_client),
 *  and return it WITHOUT a signature. Caller's next step is
 *  `exportServerPassport` which projects + signs + audits. */
export const collectFullPassport = async (
  args: CollectFullPassportArgs,
): Promise<Omit<ServerPassport, 'signature' | 'profile'>> => {
  const now = args.now ?? Date.now;
  const mintId = args.mintId ?? randomUUID;
  const [identity, network, clients, capabilities, recovery, key_health] =
    await Promise.all([
      args.providers.loadIdentity(),
      args.providers.loadNetwork(),
      args.providers.loadClients(),
      args.providers.loadCapabilities(),
      args.providers.loadRecovery(),
      args.providers.loadKeyHealth(),
    ]);
  const base = {
    passport_version: SERVER_PASSPORT_VERSION,
    passport_id: mintId(),
    exported_at: now(),
    exported_by_client_id: args.exported_by_client_id,
    identity,
    network,
    clients,
    capabilities,
    recovery,
    key_health,
  } as Omit<ServerPassport, 'signature' | 'profile'>;
  if (args.reason !== undefined) {
    (base as ServerPassport).reason = args.reason;
  }
  return base;
};

export interface ExportServerPassportArgs {
  providers: PassportBlockProviders;
  serverIdentity: Ed25519Keypair;
  audit: PassportAuditEmitter;
  exported_by_client_id: string;
  options: ServerPassportExportOptions;
  now?: () => number;
  mintId?: () => string;
  /** When provided, the substrate also persists a row to the
   *  passport-history store. Optional because the spec's audit ledger
   *  + `passport.list` rpc both read off the underlying audit log; the
   *  history store is a denormalized convenience cache for fast list
   *  rendering at Settings → Account → Passport History. */
  history?: PassportHistoryStore;
}

/** Mint a fresh passport, project per profile, sign with the
 *  server identity, emit the high-assurance audit row, return the
 *  signed projection. Failure modes:
 *    - block-provider rejects: error propagates; no audit row written
 *      (no INTENT to record beyond the failed call).
 *    - sign throws: audit row already written + flagged with the
 *      failure detail; signed result is the throw — caller handles.
 *    - audit row write throws: signed result is the throw; the
 *      passport never leaves this function so it can't be paired with
 *      a missing ledger row. */
export const exportServerPassport = async (
  args: ExportServerPassportArgs,
): Promise<ServerPassportProjection> => {
  const now = args.now ?? Date.now;
  const fullSansProfile = await collectFullPassport({
    providers: args.providers,
    exported_by_client_id: args.exported_by_client_id,
    ...(args.options.reason !== undefined ? { reason: args.options.reason } : {}),
    now,
    ...(args.mintId ? { mintId: args.mintId } : {}),
  });
  // Construct the FULL passport (with a placeholder profile) then
  // project — `projectServerPassport` strips the placeholder signature
  // (none is set yet, so the strip is a no-op for signature; for the
  // shape it returns a profile-tagged projection without signature).
  const fullCarrier: ServerPassport = {
    ...fullSansProfile,
    profile: args.options.profile,
    signature: '',
  };
  const projectionUnsigned = projectServerPassport(fullCarrier, args.options.profile);
  const canonical = canonicalJSONStringify(projectionUnsigned);
  // Audit BEFORE sign per the module-level rationale: intent is what
  // we're recording, even if sign fails the row stays.
  const auditEntry: ActivityEntry = {
    activity_id: '',
    timestamp: fullSansProfile.exported_at,
    action: 'passport.exported',
    target: fullSansProfile.passport_id,
    detail: passportAuditDetail(args.options.profile, args.options.reason),
  };
  await args.audit.log(auditEntry);
  // Sign: produces an Ed25519 signature over the canonical bytes of
  // the unsigned projection. Verifier reproduces the canonicalization
  // + verifies against `identity.server_public_key`.
  const signature = ed25519Sign(args.serverIdentity, canonical);
  const signed = { ...projectionUnsigned, signature } as ServerPassportProjection;
  if (args.history) {
    await args.history.append({
      passport_id: fullSansProfile.passport_id,
      profile: args.options.profile,
      exported_at: fullSansProfile.exported_at,
      exported_by_client_id: args.exported_by_client_id,
      ...(args.options.reason !== undefined ? { reason: args.options.reason } : {}),
      signer_fingerprint: args.serverIdentity.public_key_fingerprint,
    });
  }
  return signed;
};

const passportAuditDetail = (
  profile: ServerPassportProfile,
  reason: string | undefined,
): string => {
  if (reason && reason.length > 0) return `profile=${profile}; reason=${reason}`;
  return `profile=${profile}`;
};

// ────────────────────────────────────────────────────────────────
// Verification
// ────────────────────────────────────────────────────────────────

export type PassportVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'signature_missing'
        | 'signature_malformed'
        | 'signature_invalid'
        | 'identity_block_missing_public_key'
        | 'profile_unknown';
    };

/** Verify any passport projection. The verifier:
 *
 *    1. Reads the embedded `identity.server_public_key` (every profile
 *       carries the public-key block — `support_redacted` ships only
 *       the `server_public_key` + `server_identity_fingerprint` +
 *       `current_handle`; `enterprise_audit` and `migration_full` ship
 *       the full identity block).
 *    2. Strips `signature` from the carried passport.
 *    3. Canonicalizes the remaining bytes via `canonicalJSONStringify`.
 *    4. Ed25519-verifies the signature against the carried public key.
 *
 *  The signature commits to the projection — verifying a
 *  `support_redacted` payload as `migration_full` (without re-signing)
 *  fails because the canonical bytes carry the embedded `profile`
 *  field which is part of the signed payload.
 *
 *  ⛔⛔ `ok: true` MEANS SELF-CONSISTENT, NOT AUTHENTIC. The key this verifies
 *  against is the one the passport CARRIES, so anyone can mint a passport with
 *  their own keypair and it will verify. This answers "was this bundle signed
 *  by the holder of the key it names", never "is that key who you think".
 *
 *  ⇒ EVERY CALLER MUST BIND THE CARRIED KEY TO SOMETHING IT ALREADY TRUSTS.
 *  `previewImportPassport` does it by recomputing the fingerprint of
 *  `server_public_key` and requiring it to equal the claimed
 *  `server_identity_fingerprint`; a caller with a pinned key should compare
 *  against that instead. This was already gotten wrong once — Codex R26.4 Δ5
 *  #1 found an import path that recorded a victim's claimed fingerprint as
 *  proven provenance while the bundle was signed by the attacker's own key —
 *  and the note explaining it lives at that call site, where somebody had
 *  already worked it out. It belongs here, where the next caller looks. */
export const verifyServerPassport = (
  passport: ServerPassportProjection,
): PassportVerifyResult => {
  const sig = passport.signature;
  if (typeof sig !== 'string' || sig.length === 0) {
    return { ok: false, reason: 'signature_missing' };
  }
  // `?? {}` keeps the verifier null-safe: a malformed projection with
  // `identity: null` / no identity block resolves to a missing public key
  // (clean `{ ok: false }`) rather than throwing a TypeError that the rpc
  // layer would surface as an opaque `internal` 500 (Codex R26.4 Δ5 #2).
  const idBlock = (passport.identity ?? {}) as Partial<ServerPassportIdentityBlock> & {
    server_public_key?: string;
  };
  const publicKey = idBlock.server_public_key;
  if (typeof publicKey !== 'string' || publicKey.length === 0) {
    return { ok: false, reason: 'identity_block_missing_public_key' };
  }
  if (
    passport.profile !== 'support_redacted' &&
    passport.profile !== 'enterprise_audit' &&
    passport.profile !== 'migration_full'
  ) {
    return { ok: false, reason: 'profile_unknown' };
  }
  const { signature: _drop, ...withoutSig } = passport;
  const canonical = canonicalJSONStringify(withoutSig);
  let verified: boolean;
  try {
    verified = ed25519Verify(publicKey, canonical, sig);
  } catch {
    return { ok: false, reason: 'signature_malformed' };
  }
  return verified
    ? { ok: true }
    : { ok: false, reason: 'signature_invalid' };
};

// ────────────────────────────────────────────────────────────────
// History store (Settings → Account → Passport History)
// ────────────────────────────────────────────────────────────────

export interface PassportHistoryEntry {
  passport_id: string;
  profile: ServerPassportProfile;
  exported_at: number;
  exported_by_client_id: string;
  reason?: string;
  signer_fingerprint: string;
}

export interface PassportHistoryStore {
  append(entry: PassportHistoryEntry): Promise<void>;
  list(args?: { limit?: number; before?: number }): Promise<PassportHistoryEntry[]>;
}

export const createInMemoryPassportHistoryStore = (): PassportHistoryStore => {
  const rows: PassportHistoryEntry[] = [];
  return {
    async append(entry) {
      rows.unshift({ ...entry });
    },
    async list(args) {
      const limit = args?.limit ?? 50;
      let scope = rows;
      if (args?.before !== undefined) {
        const before = args.before;
        scope = rows.filter((r) => r.exported_at < before);
      }
      return scope.slice(0, limit).map((r) => ({ ...r }));
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Import flow (server migration)
// ────────────────────────────────────────────────────────────────

export type PassportImportResult =
  | {
      ok: true;
      publisher_id: string;
      current_handle: string;
      handle_history: HandleHistoryEntry[];
      publisher_identity_fingerprint: string;
    }
  | {
      ok: false;
      reason:
        | 'profile_not_migration_full'
        | 'signature_missing'
        | 'signature_malformed'
        | 'signature_invalid'
        | 'identity_block_missing_public_key'
        | 'profile_unknown'
        | 'identity_block_incomplete'
        | 'identity_fingerprint_mismatch'
        | 'unsupported_passport_version';
    };

/** Recompute the `sha256:<hex>` fingerprint of a base64 SPKI-DER Ed25519
 *  public key (the `identity.server_public_key` shape). Returns null on
 *  malformed base64 / bytes so the caller treats it as a mismatch (reject)
 *  rather than throwing. Used to bind a passport's claimed identity
 *  fingerprint to the key that actually signed it. */
const serverPublicKeyFingerprint = (
  server_public_key_b64: string,
): string | null => {
  try {
    return ed25519PublicKeyFingerprint(base64ToBytes(server_public_key_b64));
  } catch {
    return null;
  }
};

/** Pre-flight import. Verifies the passport's signature, narrows to
 *  `migration_full`, and surfaces the immutable identity bundle the
 *  new server's onboarding flow stamps onto its local key store
 *  (publisher_id + handle history + publisher fingerprint). The
 *  caller's onboarding flow is responsible for actually rotating
 *  `server_identity_key` (the new server gets a fresh one) and
 *  rebinding the publisher key + handle history. The substrate
 *  refuses to import non-`migration_full` profiles (signed redaction
 *  prevents promotion).
 *
 *  Codex P8 correctness fold #7 — version check matches the webclient
 *  preview shape. The two surfaces had drifted; both now reject any
 *  `passport_version` not in the supported list. */
export const previewImportPassport = (
  passport: ServerPassportProjection,
): PassportImportResult => {
  if (!SUPPORTED_PASSPORT_VERSIONS.includes(passport.passport_version)) {
    return { ok: false, reason: 'unsupported_passport_version' };
  }
  if (passport.profile !== 'migration_full') {
    return { ok: false, reason: 'profile_not_migration_full' };
  }
  const verify = verifyServerPassport(passport);
  if (!verify.ok) {
    return { ok: false, reason: verify.reason };
  }
  const id = passport.identity as ServerPassportIdentityBlock;
  if (
    typeof id.publisher_id !== 'string' ||
    id.publisher_id.length === 0 ||
    typeof id.current_handle !== 'string' ||
    !Array.isArray(id.handle_history) ||
    typeof id.publisher_identity_fingerprint !== 'string' ||
    id.publisher_identity_fingerprint.length === 0
  ) {
    return { ok: false, reason: 'identity_block_incomplete' };
  }
  // Bind the CLAIMED server identity to the SIGNING key. `verifyServerPassport`
  // proves the bundle was signed by the holder of `server_public_key`, but
  // NOT that the claimed `server_identity_fingerprint` is that key's. Without
  // this, an attacker signs a `migration_full` passport with their OWN key
  // while claiming a victim's fingerprint, and the consumer's provenance row
  // would falsely bind the victim's identity to this server (Codex R26.4 Δ5
  // #1). Recompute the fingerprint of `server_public_key` and require it to
  // equal the claimed `server_identity_fingerprint` — the migration consumer
  // (`commitImportedPassport`) then records THIS verified fingerprint as the
  // old identity, so the provenance is cryptographically proven (under the
  // D-175 contract it IS the publisher_id). `publisher_id` itself stays an
  // unconstrained signed claim here (a pre-D-175 passport could carry a
  // distinct string); the separate `publisher_identity_fingerprint` is an
  // independently-rotated marketplace key (I-7) whose public key is not
  // carried, so it can't be bound either. The client preview
  // (`inspectImportedPassport`) does NO crypto — the server is the trust
  // boundary and re-verifies here.
  const signerFingerprint = serverPublicKeyFingerprint(id.server_public_key);
  if (
    signerFingerprint === null ||
    signerFingerprint !== id.server_identity_fingerprint
  ) {
    return { ok: false, reason: 'identity_fingerprint_mismatch' };
  }
  return {
    ok: true,
    publisher_id: id.publisher_id,
    current_handle: id.current_handle,
    handle_history: id.handle_history.map((h) => ({ ...h })),
    publisher_identity_fingerprint: id.publisher_identity_fingerprint,
  };
};

export interface CommitImportedPassportArgs {
  /** The uploaded `migration_full` passport. RE-VERIFIED here — the server
   *  never trusts the client's preview. */
  passport: ServerPassportProjection;
  /** Live server identity. Its fingerprint becomes the new `publisher_id`
   *  (D-175: `publisher_id == server_fingerprint ==
   *  serverIdentity().public_key_fingerprint`). */
  serverIdentity: Ed25519Keypair;
  /** High-assurance audit sink — emits the signed `passport.imported` row
   *  (auto-signed by the wrapper since the kind is in
   *  `HIGH_ASSURANCE_AUDIT_KINDS`). */
  audit: PassportAuditEmitter;
  /** Attribution stamped into the audit detail. */
  imported_by_client_id: string;
  /** Live handle state (publisher_id + current_handle), read ONLY to report
   *  whether the provisioner-owned cloud handle re-anchor is still pending.
   *  `null` when the server holds no handle (free / pre-reservation). Import
   *  NEVER mutates the handle store — `handle-provisioner.ts` owns the
   *  `reReserve` re-anchor (account-binding-driven, idempotent). */
  handleState?: { publisher_id: string; current_handle: string } | null;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** R26.4 Delta 5 (D-148 § A.9 import half) — COMMIT the import of a
 *  `migration_full` passport on a NEW server (model A re-anchor, owner-
 *  ratified 2026-06-25).
 *
 *  Why this is provenance-only (not a handle claim). The cloud handle
 *  re-anchor is ALREADY owned by the pro-convenience provisioner
 *  (`handle-provisioner.ts`): bound to the account, it idempotently drives
 *  `reReserve` under the live fingerprint from a background tick (and carries
 *  the documented auth-worker reservation-migration gap). Re-driving
 *  `reReserve` from here would duplicate that path and hit the same gap. So
 *  the import commit does the genuinely-missing half: re-verify the signed
 *  bundle and record a non-repudiable `passport.imported` row linking the old
 *  identity → the live one. `handle_reanchor_pending` reports whether the
 *  provisioner's re-anchor is still outstanding so the caller can surface it
 *  without duplicating the cloud path.
 *
 *  Failure modes are returned (not thrown): the verification reasons mirror
 *  `previewImportPassport`, plus `same_identity` — the passport already
 *  describes THIS live identity, so there is nothing to migrate from and a
 *  provenance row whose previous == new would mislead. */
export const commitImportedPassport = async (
  args: CommitImportedPassportArgs,
): Promise<ServerPassportImportCommitResult> => {
  const pre = previewImportPassport(args.passport);
  if (!pre.ok) {
    return { ok: false, reason: pre.reason };
  }
  const newPublisherId = args.serverIdentity.public_key_fingerprint;
  const idBlock = args.passport.identity as ServerPassportIdentityBlock;
  // `server_identity_fingerprint` is bound to the signing key by
  // `previewImportPassport`, so it is the cryptographically-VERIFIED old
  // identity (== the old publisher_id under D-175). Use it — never the
  // unconstrained `pre.publisher_id` field — for both the self-import guard
  // and the recorded provenance, so a forged `publisher_id` can't taint the
  // ledger.
  const previousServerFingerprint = idBlock.server_identity_fingerprint;
  // Self-import guard: the passport already describes THIS live identity, so
  // there is nothing to migrate from (a provenance row whose previous == new
  // would mislead).
  if (previousServerFingerprint === newPublisherId) {
    return { ok: false, reason: 'same_identity' };
  }
  // The provisioner re-anchor is pending iff the live handle state still
  // names a handle under a DIFFERENT publisher_id than the live fingerprint.
  // No handle (null / empty current_handle) ⇒ nothing to re-anchor.
  const handleReanchorPending =
    args.handleState != null &&
    args.handleState.current_handle.length > 0 &&
    args.handleState.publisher_id !== newPublisherId;
  const now = args.now ?? Date.now;
  const auditEntry: ActivityEntry = {
    activity_id: '',
    timestamp: now(),
    action: 'passport.imported',
    target: args.passport.passport_id,
    detail: passportImportedAuditDetail({
      imported_by_client_id: args.imported_by_client_id,
      previous_publisher_id: previousServerFingerprint,
      previous_server_fingerprint: previousServerFingerprint,
      publisher_identity_fingerprint: pre.publisher_identity_fingerprint,
      current_handle: pre.current_handle,
      handle_history_count: pre.handle_history.length,
      new_publisher_id: newPublisherId,
      handle_reanchor_pending: handleReanchorPending,
    }),
  };
  await args.audit.log(auditEntry);
  return {
    ok: true,
    passport_id: args.passport.passport_id,
    // The VERIFIED fingerprint (== publisher_id under D-175), never the raw
    // `pre.publisher_id` field — which is unconstrained by the binding check
    // and so spoofable. Matches the audit row + `previous_server_fingerprint`
    // so the UI's lineage display is cryptographically grounded (Codex Δ6 #1;
    // the Δ5 fold caught the audit site but the return diverged, masked by a
    // publisher_id==fingerprint test fixture).
    previous_publisher_id: previousServerFingerprint,
    previous_server_fingerprint: previousServerFingerprint,
    new_publisher_id: newPublisherId,
    current_handle: pre.current_handle,
    handle_history_count: pre.handle_history.length,
    publisher_identity_fingerprint: pre.publisher_identity_fingerprint,
    handle_reanchor_pending: handleReanchorPending,
  };
};

interface PassportImportedAuditDetailArgs {
  imported_by_client_id: string;
  previous_publisher_id: string;
  previous_server_fingerprint: string;
  publisher_identity_fingerprint: string;
  current_handle: string;
  handle_history_count: number;
  new_publisher_id: string;
  handle_reanchor_pending: boolean;
}

/** Build the `passport.imported` audit detail — a parseable `key=value`
 *  string capturing the old → new identity linkage for the forensic ledger.
 *  An empty handle renders as `<none>` so the migration of a handle-less
 *  server is unambiguous. */
const passportImportedAuditDetail = (
  args: PassportImportedAuditDetailArgs,
): string =>
  [
    `imported_by=${args.imported_by_client_id}`,
    `prev_publisher_id=${args.previous_publisher_id}`,
    `prev_server_fp=${args.previous_server_fingerprint}`,
    `publisher_identity_fp=${args.publisher_identity_fingerprint}`,
    `handle=${args.current_handle || '<none>'}`,
    `handle_history=${args.handle_history_count}`,
    `new_publisher_id=${args.new_publisher_id}`,
    `handle_reanchor_pending=${args.handle_reanchor_pending}`,
  ].join('; ');
