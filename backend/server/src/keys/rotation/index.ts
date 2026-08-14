/** D-148 § A.11 / § P7 — Key Health + Rotation Center substrate.
 *
 *  Per-class rotation flows. Each primitive is a thin orchestrator:
 *
 *    - `master_dek_rotate`     — generate new master DEK; transactional
 *                                  re-encrypt of every sub_dek-encrypted
 *                                  blob; concurrent-write pause+resume.
 *    - `server_identity_rotate` — generate new ed25519 keypair; revoke
 *                                  every paired client's bearer; live
 *                                  clients reach the unpaired-state →
 *                                  pair-form remount path on the next
 *                                  failed handshake (D-156 P9 retired
 *                                  the `pair_required` broadcast).
 *    - `publisher_identity_rotate` — generate new ed25519 keypair; re-
 *                                  sign every published recipe; bump
 *                                  marketplace upload manifest.
 *    - `tls_renew`              — invoke ACME helper (Pro) or local
 *                                  certbot/caddy hook (free); broadcast
 *                                  signed `cert_rotation_notice` with
 *                                  the new fingerprint pair.
 *    - `webclient_token_rotate` — issue fresh bearer for one paired
 *                                  client (bridge OR webclient — D-169
 *                                  P0 Slice 2B unified the bearer
 *                                  taxonomy); Argon2id-hash + persist;
 *                                  force re-pair on next handshake.
 *    - `webhook_secret_rotate`  — rotate per-vendor HMAC secret;
 *                                  invalidate every pending webhook
 *                                  (any HMAC computed against the old
 *                                  secret will fail at verification).
 *    - `mark_compromised`       — flag a class as compromised; trigger
 *                                  immediate rotation of the class +
 *                                  every dependent class (master_dek →
 *                                  every sub_dek; server_identity →
 *                                  every paired client's pair-blob).
 *
 *  Each primitive returns a `RotationResult` (closed-list shape from
 *  `@recued/contracts`). Callers stamp the audit row + emit the
 *  broadcast via `RotationSideEffects`.
 *
 *  The substrate is provider-agnostic — actual ACME calls, marketplace
 *  re-uploads, sub_dek-encrypted-blob enumeration are all injected via
 *  the dependency interfaces. This keeps the module testable + lets
 *  the production wiring evolve without touching the rotation
 *  semantics.
 */

import {
  ROTATION_OP_KEY_CLASS,
  type KeyClass,
  type KeyRotationEvent,
  type RotationOp,
  type RotationResult,
} from '@recued/contracts';
import {
  ed25519Sign,
  generateBearerToken,
  generateEd25519Keypair,
  hashBearerToken,
  type Ed25519Keypair,
  type TokenHashRecord,
} from '../index.js';
import {
  signedBytesForCertRotationNotice,
  signedBytesForCertRotationReverted,
} from './cert-rotation-verifier.js';

// ────────────────────────────────────────────────────────────────
// External substrate hooks
// ────────────────────────────────────────────────────────────────

/** Master-DEK transactional re-encryption hook. The hook iterates
 *  every sub_dek-encrypted blob in the warehouse, decrypts under the
 *  old master, re-derives the matching sub_dek under the new master,
 *  and rewrites in place. Concurrent writes during the iteration are
 *  paused at the storage boundary + resumed at the end of the rotation
 *  (the implementation owns the pause/resume primitive).
 *
 *  Codex P1 #3 fold — `installNewMaster` is invoked INSIDE the
 *  transactional boundary, after re-encryption completes + before the
 *  pause is released. The hook MUST commit-or-rollback both in one
 *  atomic step: install fails → re-encryption rolls back; install
 *  succeeds → blobs + active key flip together. The substrate refuses
 *  to call `master_dek.install` on its own — install is reachable only
 *  through `MasterDekReencryptor.rotate` so partial state cannot
 *  arise. */
export interface MasterDekReencryptor {
  /** Does this implementation also rekey the realm DATABASE?
   *
   *  D-212 derives the database key from the Master DEK, so an implementation
   *  that only re-encrypts blobs leaves the file readable by neither factor
   *  once the Master DEK moves. The rotation substrate refuses unless this is
   *  explicitly `true`, so an implementation cannot omit the rekey by silence —
   *  the omission has to be a decision someone typed. */
  readonly rekeysRealmDatabase?: boolean;
  rotate(args: {
    new_master_dek: Uint8Array;
    /** Caller-provided commit hook. The reencryptor MUST invoke this
     *  callback inside the same transactional boundary as the
     *  re-encryption work — install failure must roll back the
     *  re-encryption. The substrate exposes `master_dek.install` to
     *  the reencryptor (not the caller) precisely so the two effects
     *  cannot diverge. */
    installNewMaster: () => Promise<void>;
  }): Promise<{ reencrypted_blob_count: number }>;
}

/** Server-identity primitives. Ships the keypair store + the paired-
 *  client revocation hook. Codex P2 #6 fold — `restore(prev)` is
 *  called on dependent-work failure so the substrate can roll back the
 *  saved key when revocation/re-pair fails after the new key has been
 *  written. */
export interface ServerIdentityHooks {
  load(): Promise<Ed25519Keypair>;
  save(next: Ed25519Keypair): Promise<void>;
  /** Restore a previous identity key. Called by the rotation engine
   *  on failure paths so the substrate doesn't leave the new key
   *  active while clients still trust the old fingerprint. Defaults
   *  to `save(prev)` semantically; production may want to widen this
   *  to also clear staged-pair state. */
  restore?(prev: Ed25519Keypair): Promise<void>;
  revokeAllPairedClients(): Promise<{ revoked_client_ids: ReadonlyArray<string> }>;
  /** Codex P2 #7 fold — actively close any in-flight WS sessions
   *  authenticated under the old identity. The default hook is
   *  no-op for tests; production wires this to the ws-listener layer
   *  so paired clients receive the 401 + drop their connection
   *  rather than retry against the rotated fingerprint. */
  closeActiveSessions?(): Promise<{ closed_session_count: number }>;
}

/** Publisher-identity primitives. Re-signs every published recipe +
 *  bumps the marketplace upload manifest so consumers re-verify.
 *  Codex P2 #6 fold — `restore(prev)` mirrors `ServerIdentityHooks`. */
export interface PublisherIdentityHooks {
  load(): Promise<Ed25519Keypair>;
  save(next: Ed25519Keypair): Promise<void>;
  restore?(prev: Ed25519Keypair): Promise<void>;
  resignPublishedRecipes(args: {
    next: Ed25519Keypair;
  }): Promise<{ resigned_recipe_count: number }>;
}

/** TLS renewal hook. Production wires through the ACME helper (`Pro`
 *  tier) or the local certbot/caddy reload (`free` tier). The hook
 *  returns the new cert's fingerprint + the signed rotation notice
 *  envelope. */
export interface TlsRenewalHook {
  renew(): Promise<
    | { ok: true; new_fingerprint: string; previous_fingerprint?: string }
    | { ok: false; reason: TlsRenewalFailureReason }
  >;
}

/** Closed list of renewal failure reasons the hook may report.
 *
 *  `rate_limited` is the cloud helper's HTTP 429 — kept SEPARATE from
 *  `helper_unavailable` all the way up to the operator, because the two
 *  remediations point in opposite directions ("fix your setup" vs "stop and
 *  wait"). It used to collapse into `helper_unavailable` at
 *  `mapAcmeFailure`, and the panel then told the operator to go inspect their
 *  DDNS configuration. */
export type TlsRenewalFailureReason =
  | 'helper_unavailable'
  | 'subscription_required'
  | 'storage_io_error'
  | 'rate_limited';

/** Durable clock shared by every caller of `renewTls`. See
 *  `./tls-renew-cooldown-store.ts` for why it is a store and not a field. */
export interface TlsRenewCooldownStore {
  /** Unix-ms before which a renewal is refused. 0 ⇒ never throttled. */
  readNotBefore(): Promise<number>;
  writeNotBefore(args: {
    not_before: number;
    set_at: number;
    outcome: 'success' | 'failure';
  }): Promise<void>;
}

/** Per-bridge token store. The rotation flow revokes the old hash +
 *  issues a new bearer; persistence is injected so tests can use an
 *  in-memory map while production wires through SQLite.
 *  Codex P2 #7 fold — `closeActiveSessions` actively kicks any in-
 *  flight WS connection authenticated with the old token (rather than
 *  letting it linger until the next rate-limit refresh / TCP reset).
 *  Default no-op for tests; production wires through the WS listener. */
export interface ClientTokenStore {
  revoke(args: { client_id: string }): Promise<{ existed: boolean }>;
  store(args: {
    client_id: string;
    hash: TokenHashRecord;
    issued_at: number;
  }): Promise<void>;
  closeActiveSessions?(args: { client_id: string }): Promise<{ closed_session_count: number }>;
}

/** Per-vendor webhook secret store. Rotation re-generates the secret
 *  + drops any in-flight unverified inbound (pending HMAC verification
 *  against the old secret will fail).
 *  Codex P2 #7 fold — `fencePendingVerifications` lets the substrate
 *  invalidate any in-flight HMAC verification against the old secret
 *  rather than relying on the body-hash dedup ledger to catch them
 *  later. Default no-op for tests; production wires through the
 *  webhook port. */
export interface WebhookSecretStore {
  rotate(args: { vendor: string; new_secret: string }): Promise<{ existed: boolean }>;
  fencePendingVerifications?(args: { vendor: string }): Promise<{ fenced_count: number }>;
}

/** Side-effect surface — audit emit + broadcast. The substrate
 *  formats the event; the caller wires fan-out. */
export interface RotationSideEffects {
  recordAudit(payload: {
    op: RotationOp;
    key_class: KeyClass;
    rotated_at: number;
    new_fingerprint?: string;
    /** Non-empty when this rotation requires clients to re-pair. */
    repair_client_ids?: ReadonlyArray<string>;
    reencrypted_blob_count?: number;
    compromise: boolean;
    triggered_by_client_id: string;
    /** Free-form reason — surfaced in Settings → Audit panel. */
    reason?: string;
    /** Set when this audit row records a TLS rotation REVERT rather
     *  than a forward rotation. The op is still `tls_renew`; this
     *  flag is what lets Key Health / compliance review distinguish
     *  a rollback from a normal renewal. Mirrors
     *  `PerDomainRotationEffects.recordAudit.revert`. */
    revert?: true;
  }): Promise<void>;
  broadcast(event: KeyRotationEvent): Promise<void>;
  /** TLS renewal broadcasts a signed `cert_rotation_notice` so
   *  pinned clients accept the upcoming fingerprint without re-pair. */
  broadcastCertRotationNotice(args: {
    current_fingerprint: string;
    next_fingerprint: string;
    rotation_at: number;
    signature: string;
    signer_fingerprint: string;
    emitted_at: number;
  }): Promise<void>;
  /** TLS revert broadcasts a signed `cert_rotation_reverted` so
   *  pinned clients collapse the two-pin overlap back to the reverted
   *  fingerprint without re-pair. Mirrors the per-domain
   *  `broadcastCertDomainRotationReverted` shape. */
  broadcastCertRotationReverted(args: {
    reverted_to_fingerprint: string;
    reason?: string;
    reverted_at: number;
    signature: string;
    signer_fingerprint: string;
  }): Promise<void>;
}

/** Compromise ledger. Records that a key class has been marked
 *  compromised so the UI can surface the high-severity banner +
 *  subsequent rotation attempts read the flag. */
export interface CompromiseLedger {
  isMarked(key_class: KeyClass): Promise<boolean>;
  mark(args: {
    key_class: KeyClass;
    marked_at: number;
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<void>;
  clear(key_class: KeyClass): Promise<void>;
}

/** Clock injection. */
export type Clock = () => number;

// ────────────────────────────────────────────────────────────────
// Rotation engine
// ────────────────────────────────────────────────────────────────

export interface RotationEngineOptions {
  clock?: Clock;
  master_dek?: { current: () => Uint8Array; install: (next: Uint8Array) => Promise<void> };
  master_dek_reencryptor?: MasterDekReencryptor;
  server_identity?: ServerIdentityHooks;
  publisher_identity?: PublisherIdentityHooks;
  tls?: TlsRenewalHook;
  /** D-169 P0 Slice 2B — the single client-token store. Holds bearer
   *  rows for both `client_kind: 'bridge'` and `'webclient'` paired
   *  clients (bridge unification retired the separate `bridge_tokens`
   *  store + `rotateBridgeToken` method; `webclient_token_rotate`
   *  serves both). */
  webclient_tokens?: ClientTokenStore;
  webhook_secrets?: WebhookSecretStore;
  compromise_ledger: CompromiseLedger;
  /** Shared post-attempt cooldown for `renewTls`. Absent ⇒ NO cooldown is
   *  enforced — kept optional so the many test harnesses that build a bare
   *  engine keep working, and so a dbless subcommand composes without one.
   *  Production wiring (`wire-cert-stack.ts`) always supplies the SQLite
   *  store when a db is present. */
  tls_renew_cooldown?: TlsRenewCooldownStore;
  /** Interval a consumed attempt blocks the next one. Defaults to
   *  `DEFAULT_TLS_RENEW_COOLDOWN_MS` (6h — the same figure the housekeeping
   *  task has used since D-148, deliberately, so the two paths behave
   *  identically rather than merely similarly). */
  tls_renew_cooldown_ms?: number;
  effects: RotationSideEffects;
  /** CSPRNG hook for the master DEK. Defaults to `crypto.randomBytes(32)`. */
  generate_master_dek?: () => Uint8Array;
  /** CSPRNG hook for webhook secrets. Defaults to 32-byte URL-safe
   *  base64. */
  generate_webhook_secret?: () => string;
}

export interface RotationEngine {
  rotateMasterDek(args: { triggered_by_client_id: string; reason?: string }): Promise<RotationResult>;
  rotateServerIdentity(args: {
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<RotationResult>;
  rotatePublisherIdentity(args: {
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<RotationResult>;
  /** Codex P2 #5 fold — `rotation_at_offset_ms` schedules the cert
   *  rotation activation in the FUTURE so the signed
   *  `cert_rotation_notice` propagates ahead of the actual flip and
   *  pinned clients pick up the new fingerprint over the overlap
   *  window. Defaults to `DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS`
   *  (7 days per spec § A.6.5). Tests pin to 0 for synchronous
   *  flip-after-renew semantics. */
  renewTls(args: {
    triggered_by_client_id: string;
    reason?: string;
    rotation_at_offset_ms?: number;
  }): Promise<RotationResult>;
  /** Revert a staged-but-bad TLS rotation. Emits a signed
   *  `cert_rotation_reverted` event for pinned clients to collapse
   *  the two-pin overlap back to `reverted_to_fingerprint`, plus a
   *  `tls_renew` audit row tagged as a revert. Used when the staged
   *  cert proves bad post-emit (Reachability Doctor regression OR
   *  operator manual revert from Settings → Key Health). Mirrors the
   *  per-domain `revertDomainRotation` shape. */
  revertCert(args: {
    reverted_to_fingerprint: string;
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<RotationResult>;
  /** D-169 P0 Slice 2B — unified bearer-rotation primitive. Rotates
   *  the bearer for one paired client (bridge OR webclient). The
   *  underlying `client_tokens` table carries `client_kind` so the
   *  store routes by `client_id` regardless of which paired-client
   *  shape the bearer belongs to. */
  rotateWebclientToken(args: {
    client_id: string;
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<RotationResult>;
  rotateWebhookSecret(args: {
    vendor: string;
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<RotationResult>;
  /** Mark a class as compromised + cascade through dependent rotations.
   *  Always emits at least one audit row + one broadcast even when
   *  the class was already marked (idempotent re-acknowledgement is
   *  not the same as triggering a fresh cascade). */
  markCompromised(args: {
    key_class: KeyClass;
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<RotationResult>;
}

// Codex P7 review fold pre-emptive — rotation engine is single-process.
// Concurrent rotations of the same class race on the underlying store;
// callers must serialize at the rpc layer. The substrate guards via
// `inflightOp` per-class to surface `rotation_in_progress` cleanly.
const isAlreadyRotating = (key: string, set: Set<string>): boolean => set.has(key);

/** Codex P2 #5 fold — default lead time between emitting the signed
 *  `cert_rotation_notice` + the actual cert flip. Spec § A.6.5 calls
 *  for T-7d notice so pinned clients have time to receive + persist
 *  the next fingerprint before the active cert changes. Tests can
 *  pass `rotation_at_offset_ms: 0` for synchronous flip semantics. */
export const DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** Interval a quota-consuming renewal blocks the next one. 6h — the SAME
 *  figure `tls-cert-renewal`'s `RENEWAL_COOLDOWN_MS` has used since D-148, on
 *  purpose: two paths obeying one rule should obey one number, or the first
 *  bug report is "why did the button say wait 6h when the task waits 4". */
export const DEFAULT_TLS_RENEW_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const generateMasterDek = (): Uint8Array => {
  // Lazy import to keep contracts compatibility — the substrate runs
  // server-side only so node:crypto is always available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return new Uint8Array(randomBytes(32));
};

const generateWebhookSecret = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return randomBytes(32).toString('base64url');
};

export const createRotationEngine = (
  opts: RotationEngineOptions,
): RotationEngine => {
  const clock = opts.clock ?? Date.now;
  const inflight = new Set<string>();
  const genMaster = opts.generate_master_dek ?? generateMasterDek;
  const genWebhook = opts.generate_webhook_secret ?? generateWebhookSecret;

  const guard = async <T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T | { rotation_in_progress: true }> => {
    if (isAlreadyRotating(key, inflight)) {
      return { rotation_in_progress: true };
    }
    inflight.add(key);
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  };

  const fail = (op: RotationOp, error: RotationResult & { ok: false }): RotationResult => error;

  return {
    async rotateMasterDek({ triggered_by_client_id, reason }) {
      if (!opts.master_dek || !opts.master_dek_reencryptor) {
        return { ok: false, op: 'master_dek_rotate', error: 'key_not_loaded' };
      }
      // D-212 made the realm DATABASE key a pure function of the Master DEK
      // (`deriveSubDEK(masterDEK, 'database')`), and this substrate does not
      // know that. A completed rotation would re-wrap both bundle wraps to the
      // new Master DEK while the file stayed encrypted under the old `database`
      // sub-DEK — after which neither the keyfile nor the 24-word recovery key
      // opens it again. Whole realm, unrecoverable.
      //
      // Unreachable today (no composition supplies a reencryptor), which is
      // exactly why this guard is here rather than a comment: the wiring note
      // in `wire-cert-stack.ts` invites a future slice to supply one, and
      // `key-health-panel.ts` already tells users rotation re-encrypts the
      // whole warehouse. Whoever wires it must add the database rekey and
      // delete this branch in the same change.
      if (!opts.master_dek_reencryptor.rekeysRealmDatabase) {
        return { ok: false, op: 'master_dek_rotate', error: 'database_rekey_unsupported' };
      }
      const result = await guard<RotationResult>('master_dek', async () => {
        const next = genMaster();
        // Codex P1 #3 fold — install + re-encrypt happen inside ONE
        // transactional boundary owned by the reencryptor. The
        // substrate hands the install hook IN; the reencryptor invokes
        // it after re-encryption succeeds + before releasing the write
        // pause, so the active key flips iff the blobs are re-encrypted.
        // Install failure rolls back re-encryption (the reencryptor
        // implementation is responsible for the rollback semantics);
        // the substrate surfaces the failure as a thrown exception
        // which the caller treats as a rotation failure.
        const reenc = await opts.master_dek_reencryptor!.rotate({
          new_master_dek: next,
          installNewMaster: async () => {
            await opts.master_dek!.install(next);
          },
        });
        const compromise = await opts.compromise_ledger.isMarked('master_dek');
        // Successful rotation clears the compromise flag — the dirty
        // material is gone from the active path.
        if (compromise) await opts.compromise_ledger.clear('master_dek');
        const rotated_at = clock();
        await opts.effects.recordAudit({
          op: 'master_dek_rotate',
          key_class: 'master_dek',
          rotated_at,
          reencrypted_blob_count: reenc.reencrypted_blob_count,
          compromise,
          triggered_by_client_id,
          ...(reason !== undefined ? { reason } : {}),
        });
        await opts.effects.broadcast({
          type: 'key_rotation',
          op: 'master_dek_rotate',
          key_class: 'master_dek',
          rotated_at,
          repair_required: false,
          compromise,
        });
        return {
          ok: true,
          op: 'master_dek_rotate',
          key_class: 'master_dek',
          reencrypted_blob_count: reenc.reencrypted_blob_count,
          rotated_at,
        };
      });
      if ('rotation_in_progress' in result) {
        return { ok: false, op: 'master_dek_rotate', error: 'rotation_in_progress' };
      }
      return result;
    },

    async rotateServerIdentity({ triggered_by_client_id, reason }) {
      if (!opts.server_identity) {
        return { ok: false, op: 'server_identity_rotate', error: 'key_not_loaded' };
      }
      const result = await guard<RotationResult>('server_identity_key', async () => {
        // Codex P2 #6 fold — capture the previous identity BEFORE
        // saving the new one so dependent-work failure (revocation +
        // active-session-close) can roll back to the previous key.
        // Without rollback we'd leave the new key active while clients
        // still trust the old fingerprint.
        const prev = await opts.server_identity!.load();
        const next = generateEd25519Keypair('server_identity_key');
        await opts.server_identity!.save(next);
        let revoke: { revoked_client_ids: ReadonlyArray<string> };
        let compromiseSnapshot: boolean;
        let rotated_at: number;
        try {
          revoke = await opts.server_identity!.revokeAllPairedClients();
          // D-156 P9 — drop the bus-side `pair_required` broadcast that
          // previously fired here. The natural disconnect →
          // unpaired-state → pair-form remount path (driven by the
          // webclient's `onReauthRequired` funnel) is the only required
          // recovery signal post-rotation; the compromise check stays
          // because the audit row downstream still consumes it.
          compromiseSnapshot = await opts.compromise_ledger.isMarked('server_identity_key');
          rotated_at = clock();
          // Codex P2 #7 fold — actively close any in-flight WS session
          // authenticated against the old identity. Optional hook;
          // tests pass the no-op default.
          if (opts.server_identity!.closeActiveSessions) {
            await opts.server_identity!.closeActiveSessions();
          }
        } catch (err) {
          // Roll back to the previous identity. The substrate prefers
          // `restore(prev)` when wired so production can also clear
          // staged-pair state; otherwise fall back to `save(prev)`.
          if (opts.server_identity!.restore) {
            await opts.server_identity!.restore(prev);
          } else {
            await opts.server_identity!.save(prev);
          }
          throw err;
        }
        if (compromiseSnapshot) await opts.compromise_ledger.clear('server_identity_key');
        await opts.effects.recordAudit({
          op: 'server_identity_rotate',
          key_class: 'server_identity_key',
          rotated_at,
          new_fingerprint: next.public_key_fingerprint,
          repair_client_ids: revoke.revoked_client_ids,
          compromise: compromiseSnapshot,
          triggered_by_client_id,
          ...(reason !== undefined ? { reason } : {}),
        });
        await opts.effects.broadcast({
          type: 'key_rotation',
          op: 'server_identity_rotate',
          key_class: 'server_identity_key',
          rotated_at,
          repair_required: true,
          compromise: compromiseSnapshot,
        });
        return {
          ok: true,
          op: 'server_identity_rotate',
          key_class: 'server_identity_key',
          new_fingerprint: next.public_key_fingerprint,
          repair_client_ids: revoke.revoked_client_ids,
          rotated_at,
        };
      });
      if ('rotation_in_progress' in result) {
        return { ok: false, op: 'server_identity_rotate', error: 'rotation_in_progress' };
      }
      return result;
    },

    async rotatePublisherIdentity({ triggered_by_client_id, reason }) {
      if (!opts.publisher_identity) {
        return { ok: false, op: 'publisher_identity_rotate', error: 'key_not_loaded' };
      }
      const result = await guard<RotationResult>('publisher_identity_key', async () => {
        // Codex P2 #6 fold — same restore-on-failure pattern as
        // server_identity. Re-sign failure must roll back to the
        // previous publisher identity so marketplace consumers don't
        // see a key that the server can't actually produce signatures
        // with for already-published recipes.
        const prev = await opts.publisher_identity!.load();
        const next = generateEd25519Keypair('publisher_identity_key');
        await opts.publisher_identity!.save(next);
        let resigned: { resigned_recipe_count: number };
        try {
          resigned = await opts.publisher_identity!.resignPublishedRecipes({ next });
        } catch (err) {
          if (opts.publisher_identity!.restore) {
            await opts.publisher_identity!.restore(prev);
          } else {
            await opts.publisher_identity!.save(prev);
          }
          throw err;
        }
        const compromise = await opts.compromise_ledger.isMarked('publisher_identity_key');
        if (compromise) await opts.compromise_ledger.clear('publisher_identity_key');
        const rotated_at = clock();
        await opts.effects.recordAudit({
          op: 'publisher_identity_rotate',
          key_class: 'publisher_identity_key',
          rotated_at,
          new_fingerprint: next.public_key_fingerprint,
          compromise,
          triggered_by_client_id,
          ...(reason !== undefined ? { reason } : {}),
        });
        await opts.effects.broadcast({
          type: 'key_rotation',
          op: 'publisher_identity_rotate',
          key_class: 'publisher_identity_key',
          rotated_at,
          repair_required: false,
          compromise,
        });
        return {
          ok: true,
          op: 'publisher_identity_rotate',
          key_class: 'publisher_identity_key',
          new_fingerprint: next.public_key_fingerprint,
          rotated_at,
          dependents: [
            { key_class: 'publisher_identity_key', affected_count: resigned.resigned_recipe_count },
          ],
        };
      });
      if ('rotation_in_progress' in result) {
        return { ok: false, op: 'publisher_identity_rotate', error: 'rotation_in_progress' };
      }
      return result;
    },

    async renewTls({ triggered_by_client_id, reason, rotation_at_offset_ms }) {
      if (!opts.tls || !opts.server_identity) {
        return { ok: false, op: 'tls_renew', error: 'key_not_loaded' };
      }

      // ── Shared cooldown gate ────────────────────────────────────────
      // 🔑 THE ENFORCEMENT POINT FOR BOTH CALLERS. The operator `tls.renew`
      // rpc and the `tls-cert-renewal` housekeeping task both arrive here,
      // so this is the only layer where one clock can cover both. The task
      // keeps its own cursor check upstream as a cheap pre-filter — it can
      // only make the task call LESS often, never more, so the two cannot
      // drift into disagreement about whether a renewal is permitted.
      const cooldownStore = opts.tls_renew_cooldown;
      const cooldownMs = opts.tls_renew_cooldown_ms ?? DEFAULT_TLS_RENEW_COOLDOWN_MS;

      // ⛔⛔ A COMPROMISED KEY IS EXEMPT, AND THIS IS NOT OPTIONAL.
      //     `markCompromised` cascades into this method for
      //     `tls_private_key` (see the `case 'tls_private_key'` arm below).
      //     Throttling that path would refuse the emergency replacement of a
      //     key the operator has just declared burned — turning a rate limit
      //     into a security failure — and it would surface as a
      //     `cascade_failures` entry rather than anything loud.
      //
      // 🔑 DERIVED, NOT PASSED. A `bypass_cooldown` argument would be
      //    reachable from the `tls.renew` rpc, which is the surface the
      //    cooldown exists to gate; asking the ledger instead means the
      //    exemption requires a real compromise mark that someone had to
      //    record. `renewTls` already reads this ledger further down, so it
      //    is the same fact, read once earlier.
      //    ⚠ Read AT ENTRY and deliberately NOT reused by the post-renewal
      //      `compromise` read below. That one asks a different question at a
      //      different time ("was this key compromised by the time we
      //      finished, so should the mark be cleared and the audit row
      //      stamped"), across an ACME round trip a mark can land in the
      //      middle of. Same ledger, two moments; collapsing them would
      //      change clear-semantics for a compromise recorded mid-renewal.
      const compromisedAtEntry = await opts.compromise_ledger.isMarked('tls_private_key');

      if (cooldownStore && !compromisedAtEntry) {
        const notBefore = await cooldownStore.readNotBefore();
        const now = clock();
        if (now < notBefore) {
          return {
            ok: false,
            op: 'tls_renew',
            error: 'renew_cooldown',
            // ⚠ SET `message` ON PURPOSE. `renew_cooldown` is a new member of
            // `RotationErrorCode`; a webclient older than this server has no
            // copy for it and falls back to `result.message` verbatim
            // (`tls-renew-panel.ts` → `remediationFor(code, lastErrorMessage)`).
            // Without this the older panel renders an empty remediation.
            message:
              `A TLS renewal was already run. The next one is available at ${new Date(notBefore).toISOString()}.`,
          };
        }
      }

      /** Record that this attempt consumed remote issuance quota.
       *
       *  ⛔ NOT CALLED ON EVERY FAILURE, and that is the whole design. A
       *  `helper_unavailable` / `subscription_required` / `storage_io_error`
       *  attempt never reached the CA, so it burned no certificate quota —
       *  blocking the operator for 6h after they failed to authenticate,
       *  when the fix is to re-authenticate and click again, would make the
       *  button feel broken and teach people to restart the server to clear
       *  it. The housekeeping task still backs off on those via its own
       *  cursor, which is the layer that cares about attempt thrashing.
       *  This clock cares about ISSUANCE.
       *
       *  Success anchors to `rotated_at`, not `now`: until the staged cert
       *  actually flips, the cert source still reports the OLD cert, so an
       *  earlier unblock would re-issue against a cert that looks unrenewed
       *  and pile up conflicting staged fingerprints. Same reasoning — and
       *  the same anchor — as the housekeeping task's Codex P2 #1 fold. */
      const consumeCooldown = async (
        anchor: number,
        outcome: 'success' | 'failure',
      ): Promise<void> => {
        if (!cooldownStore) return;
        await cooldownStore.writeNotBefore({
          not_before: anchor + cooldownMs,
          set_at: clock(),
          outcome,
        });
      };

      const result = await guard<RotationResult>('tls_private_key', async () => {
        const renewal = await opts.tls!.renew();
        if (!renewal.ok) {
          if (renewal.reason === 'rate_limited') {
            // The cloud helper refused on quota. Back off exactly as if we
            // had succeeded-and-must-wait: another attempt now would be
            // refused again and spend a round trip proving it.
            await consumeCooldown(clock(), 'failure');
            return {
              ok: false,
              op: 'tls_renew',
              error: 'renew_rate_limited',
              // Same forward-compat reason as `renew_cooldown` above.
              message:
                "Today's certificate issuance allowance for this server is spent. It resets 24 hours after the first issuance in the current window.",
            } as RotationResult;
          }
          const code: 'acme_helper_unavailable' | 'subscription_required' | 'storage_io_error' =
            renewal.reason === 'helper_unavailable' ? 'acme_helper_unavailable' : renewal.reason;
          return { ok: false, op: 'tls_renew', error: code } as RotationResult;
        }
        const compromise = await opts.compromise_ledger.isMarked('tls_private_key');
        if (compromise) await opts.compromise_ledger.clear('tls_private_key');
        const emitted_at = clock();
        // Codex P2 #5 fold — schedule activation in the future so the
        // signed notice propagates ahead of the cert flip; pinned
        // clients persist `next_fingerprint` and accept either over
        // the overlap window. Default lead = 7d per spec § A.6.5;
        // caller can pin offset to 0 for synchronous test flows.
        const lead = rotation_at_offset_ms ?? DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS;
        const rotated_at = emitted_at + lead;
        // Sign the rotation notice with the CURRENT server_identity_key
        // so offline clients can verify when they reconnect post-overlap.
        const signer = await opts.server_identity!.load();
        // Literal-order JSON of the unsigned payload — matches the
        // `CertRotationNotice` shape minus signature + signer_fingerprint
        // + emitted_at (signature commits to the four primary fields).
        // Shared helper so the verifier on the receive side + the rotation
        // engine on the emit side cannot drift.
        const signature = ed25519Sign(
          signer,
          signedBytesForCertRotationNotice({
            current_fingerprint: renewal.previous_fingerprint ?? '',
            next_fingerprint: renewal.new_fingerprint,
            rotation_at: rotated_at,
          }),
        );
        await opts.effects.broadcastCertRotationNotice({
          current_fingerprint: renewal.previous_fingerprint ?? '',
          next_fingerprint: renewal.new_fingerprint,
          rotation_at: rotated_at,
          signature,
          signer_fingerprint: signer.public_key_fingerprint,
          emitted_at,
        });
        await opts.effects.recordAudit({
          op: 'tls_renew',
          key_class: 'tls_private_key',
          rotated_at,
          new_fingerprint: renewal.new_fingerprint,
          compromise,
          triggered_by_client_id,
          ...(reason !== undefined ? { reason } : {}),
        });
        await opts.effects.broadcast({
          type: 'key_rotation',
          op: 'tls_renew',
          key_class: 'tls_private_key',
          rotated_at,
          repair_required: false,
          compromise,
        });
        // A certificate was issued — this is the outcome that spends the CA's
        // duplicate-certificate allowance, so it is the one the shared clock
        // exists for. Written LAST so a throw anywhere above leaves the
        // operator able to retry rather than locked out by a rotation that
        // did not complete.
        await consumeCooldown(rotated_at, 'success');
        return {
          ok: true,
          op: 'tls_renew',
          key_class: 'tls_private_key',
          new_fingerprint: renewal.new_fingerprint,
          rotated_at,
        };
      });
      // ⛔ NO COOLDOWN CONSUMED HERE. `rotation_in_progress` means the guard
      // refused before running anything — nothing reached the CA, and the
      // caller that IS running will write the clock on its own outcome.
      // Consuming here would let a losing racer push out the winner's window.
      if ('rotation_in_progress' in result) {
        return { ok: false, op: 'tls_renew', error: 'rotation_in_progress' };
      }
      return result;
    },

    async revertCert({ reverted_to_fingerprint, triggered_by_client_id, reason }) {
      if (!opts.server_identity) {
        return { ok: false, op: 'tls_renew', error: 'key_not_loaded' };
      }
      // Reject malformed input at the substrate boundary so emitters
      // cannot produce reverts the receive-side applier deterministically
      // discards. Mirrors the per-domain engine's `invalid_fingerprint`
      // gate.
      if (typeof reverted_to_fingerprint !== 'string' || reverted_to_fingerprint.length === 0) {
        return { ok: false, op: 'tls_renew', error: 'unsigned_notice' };
      }
      const result = await guard<RotationResult>('tls_private_key', async () => {
        const reverted_at = clock();
        const signer = await opts.server_identity!.load();
        const signature = ed25519Sign(
          signer,
          signedBytesForCertRotationReverted({
            reverted_to_fingerprint,
            reverted_at,
            ...(reason !== undefined ? { reason } : {}),
          }),
        );
        await opts.effects.broadcastCertRotationReverted({
          reverted_to_fingerprint,
          ...(reason !== undefined ? { reason } : {}),
          reverted_at,
          signature,
          signer_fingerprint: signer.public_key_fingerprint,
        });
        await opts.effects.recordAudit({
          op: 'tls_renew',
          key_class: 'tls_private_key',
          rotated_at: reverted_at,
          new_fingerprint: reverted_to_fingerprint,
          compromise: false,
          triggered_by_client_id,
          // Codex P2 fold — tag the row as a revert so audit consumers
          // (Key Health surface + compliance review) can distinguish
          // rollback from a normal forward renewal. Without this flag
          // the row is shape-indistinguishable from a successful
          // `renewTls` audit. Mirrors per-domain `revert: true`.
          revert: true,
          ...(reason !== undefined ? { reason } : {}),
        });
        return {
          ok: true,
          op: 'tls_renew',
          key_class: 'tls_private_key',
          new_fingerprint: reverted_to_fingerprint,
          rotated_at: reverted_at,
        };
      });
      if ('rotation_in_progress' in result) {
        return { ok: false, op: 'tls_renew', error: 'rotation_in_progress' };
      }
      return result;
    },

    async rotateWebclientToken({ client_id, triggered_by_client_id, reason }) {
      if (!opts.webclient_tokens) {
        return { ok: false, op: 'webclient_token_rotate', error: 'key_not_loaded' };
      }
      const result = await guard<RotationResult>(
        `webclient_token:${client_id}`,
        async () => {
          const revoke = await opts.webclient_tokens!.revoke({ client_id });
          if (!revoke.existed) {
            return { ok: false, op: 'webclient_token_rotate', error: 'target_not_found' } as RotationResult;
          }
          // Codex P2 #7 fold — same active-session-close as the bridge
          // path; the webclient observing 401 is what drives the
          // re-pair affordance, not retry-with-old-token.
          if (opts.webclient_tokens!.closeActiveSessions) {
            await opts.webclient_tokens!.closeActiveSessions({ client_id });
          }
          const next = generateBearerToken();
          const hash = await hashBearerToken(next);
          const rotated_at = clock();
          await opts.webclient_tokens!.store({ client_id, hash, issued_at: rotated_at });
          const compromise = await opts.compromise_ledger.isMarked('webclient_token');
          if (compromise) await opts.compromise_ledger.clear('webclient_token');
          await opts.effects.recordAudit({
            op: 'webclient_token_rotate',
            key_class: 'webclient_token',
            rotated_at,
            repair_client_ids: [client_id],
            compromise,
            triggered_by_client_id,
            ...(reason !== undefined ? { reason } : {}),
          });
          await opts.effects.broadcast({
            type: 'key_rotation',
            op: 'webclient_token_rotate',
            key_class: 'webclient_token',
            rotated_at,
            repair_required: true,
            compromise,
          });
          return {
            ok: true,
            op: 'webclient_token_rotate',
            key_class: 'webclient_token',
            issued_token: next,
            repair_client_ids: [client_id],
            rotated_at,
          };
        },
      );
      if ('rotation_in_progress' in result) {
        return { ok: false, op: 'webclient_token_rotate', error: 'rotation_in_progress' };
      }
      return result;
    },

    async rotateWebhookSecret({ vendor, triggered_by_client_id, reason }) {
      if (!opts.webhook_secrets) {
        return { ok: false, op: 'webhook_secret_rotate', error: 'key_not_loaded' };
      }
      const result = await guard<RotationResult>(
        `webhook_secret:${vendor}`,
        async () => {
          const next = genWebhook();
          const rot = await opts.webhook_secrets!.rotate({ vendor, new_secret: next });
          if (!rot.existed) {
            return { ok: false, op: 'webhook_secret_rotate', error: 'target_not_found' } as RotationResult;
          }
          // Codex P2 #7 fold — fence any in-flight HMAC verification
          // against the old secret. Pending verifications fail at the
          // verifier rather than waiting for the body-hash dedup
          // ledger to catch the replay later. Optional hook; no-op
          // for tests.
          if (opts.webhook_secrets!.fencePendingVerifications) {
            await opts.webhook_secrets!.fencePendingVerifications({ vendor });
          }
          const rotated_at = clock();
          const compromise = await opts.compromise_ledger.isMarked('webhook_secret');
          if (compromise) await opts.compromise_ledger.clear('webhook_secret');
          await opts.effects.recordAudit({
            op: 'webhook_secret_rotate',
            key_class: 'webhook_secret',
            rotated_at,
            compromise,
            triggered_by_client_id,
            ...(reason !== undefined ? { reason } : {}),
          });
          await opts.effects.broadcast({
            type: 'key_rotation',
            op: 'webhook_secret_rotate',
            key_class: 'webhook_secret',
            rotated_at,
            repair_required: false,
            compromise,
          });
          return {
            ok: true,
            op: 'webhook_secret_rotate',
            key_class: 'webhook_secret',
            issued_token: next,
            rotated_at,
          };
        },
      );
      if ('rotation_in_progress' in result) {
        return { ok: false, op: 'webhook_secret_rotate', error: 'rotation_in_progress' };
      }
      return result;
    },

    async markCompromised({ key_class, triggered_by_client_id, reason }) {
      const already = await opts.compromise_ledger.isMarked(key_class);
      if (already) {
        return { ok: false, op: 'mark_compromised', error: 'compromise_already_recorded' };
      }
      await opts.compromise_ledger.mark({
        key_class,
        marked_at: clock(),
        triggered_by_client_id,
        ...(reason !== undefined ? { reason } : {}),
      });
      // Cascade: trigger immediate rotation of the marked class. The
      // dependent re-derivation happens inside the per-op flow (e.g.
      // master_dek_rotate re-derives every sub_dek). We surface the
      // cascade as a `dependents` summary on the result.
      // Codex P1 #2 fold — track cascade failures explicitly.
      // Spec § A.11 makes "Mark compromised" a load-bearing incident-
      // response affordance: if the dependent rotation can't run, the
      // compromise alert MUST stay active + the result MUST surface
      // the failure (silently succeeding leaves dirty material in the
      // active path while the UI shows green). For selector-required
      // classes (webclient_token / webhook_secret) the compromise
      // stays marked + the result calls out that the operator must
      // run the per-target rotation themselves.
      const rotated_at = clock();
      const dependents: Array<{ key_class: KeyClass; affected_count: number }> = [];
      const cascade_failures: Array<{ key_class: KeyClass; error: string }> = [];
      const cascade_pending: Array<{ key_class: KeyClass; reason: 'selector_required' }> = [];
      switch (key_class) {
        case 'master_dek': {
          const r = await this.rotateMasterDek({ triggered_by_client_id, reason });
          if (r.ok) dependents.push({ key_class: 'master_dek', affected_count: r.reencrypted_blob_count ?? 0 });
          else cascade_failures.push({ key_class: 'master_dek', error: r.error });
          break;
        }
        case 'server_identity_key': {
          const r = await this.rotateServerIdentity({
            triggered_by_client_id,
            reason,
          });
          if (r.ok) dependents.push({
            key_class: 'server_identity_key',
            affected_count: r.repair_client_ids?.length ?? 0,
          });
          else cascade_failures.push({ key_class: 'server_identity_key', error: r.error });
          break;
        }
        case 'publisher_identity_key': {
          const r = await this.rotatePublisherIdentity({ triggered_by_client_id, reason });
          if (r.ok && r.dependents) dependents.push(...r.dependents);
          else if (!r.ok) cascade_failures.push({ key_class: 'publisher_identity_key', error: r.error });
          break;
        }
        case 'tls_private_key': {
          const r = await this.renewTls({ triggered_by_client_id, reason });
          if (r.ok) dependents.push({ key_class: 'tls_private_key', affected_count: 1 });
          else cascade_failures.push({ key_class: 'tls_private_key', error: r.error });
          break;
        }
        case 'webclient_token':
        case 'webhook_secret':
          // Selector required — the substrate cannot infer which
          // client / vendor to rotate without the caller naming the
          // target. Compromise stays active in the ledger until the
          // operator runs the per-target rotation rpc.
          cascade_pending.push({ key_class, reason: 'selector_required' });
          break;
        case 'sub_dek':
          // sub_dek compromise implies master_dek compromise — escalate.
          // The cascade lands above by re-entering with master_dek;
          // the substrate refuses to mark master_dek twice via the
          // inflight ledger above so we just trigger the escalation.
          await opts.compromise_ledger.mark({
            key_class: 'master_dek',
            marked_at: rotated_at,
            triggered_by_client_id,
            ...(reason !== undefined ? { reason: `sub_dek compromise → master_dek escalation${reason ? `: ${reason}` : ''}` } : {}),
          });
          {
            const r = await this.rotateMasterDek({ triggered_by_client_id, reason });
            if (r.ok) {
              dependents.push({ key_class: 'master_dek', affected_count: r.reencrypted_blob_count ?? 0 });
              // R26.4 Delta 3 (Codex P2 fold) — rotating master_dek
              // re-derives every sub_dek, so the leaked sub_dek material
              // is dead post-rotation. Clear the sub_dek flag the generic
              // mark above set; otherwise it persists as a permanent stale
              // compromise alert (the durable ledger + Key Health view
              // surface it across restarts). Only on SUCCESS — a failed
              // escalation leaves both flags set so the operator acts.
              await opts.compromise_ledger.clear('sub_dek');
            } else {
              cascade_failures.push({ key_class: 'master_dek', error: r.error });
            }
          }
          break;
        default:
          break;
      }
      // Codex P1 #2 fold — when any cascade rotation failed, keep the
      // compromise flag active + surface the failure as an ok=false
      // result so the UI banner stays + the operator runs the failed
      // op manually.
      if (cascade_failures.length > 0) {
        return {
          ok: false,
          op: 'mark_compromised',
          error: 'storage_io_error',
          message: `cascade rotation failed for ${cascade_failures
            .map((f) => `${f.key_class}: ${f.error}`)
            .join('; ')}`,
        };
      }
      await opts.effects.recordAudit({
        op: 'mark_compromised',
        key_class,
        rotated_at,
        compromise: true,
        triggered_by_client_id,
        ...(reason !== undefined ? { reason } : {}),
      });
      await opts.effects.broadcast({
        type: 'key_rotation',
        op: 'mark_compromised',
        key_class,
        rotated_at,
        repair_required: key_class === 'server_identity_key' || key_class === 'webclient_token',
        compromise: true,
      });
      return {
        ok: true,
        op: 'mark_compromised',
        key_class,
        rotated_at,
        dependents,
        ...(cascade_pending.length > 0 ? { cascade_pending } : {}),
      };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// In-memory ledger + token store helpers (testing + bootstrap)
// ────────────────────────────────────────────────────────────────

/** In-memory compromise ledger. Production wires through SQLite via
 *  the D-148 P5 `server_state` table. */
export const createInMemoryCompromiseLedger = (): CompromiseLedger => {
  const set = new Set<KeyClass>();
  return {
    async isMarked(key_class) {
      return set.has(key_class);
    },
    async mark({ key_class }) {
      set.add(key_class);
    },
    async clear(key_class) {
      set.delete(key_class);
    },
  };
};

/** In-memory client token store. Production wires through SQLite. */
export const createInMemoryClientTokenStore = (): ClientTokenStore => {
  const map = new Map<string, TokenHashRecord>();
  return {
    async revoke({ client_id }) {
      const existed = map.has(client_id);
      map.delete(client_id);
      return { existed };
    },
    async store({ client_id, hash }) {
      map.set(client_id, hash);
    },
  };
};

// re-export the registry for convenience.
export { ROTATION_OP_KEY_CLASS };

// D-148 § A.6.5 — re-export the single-domain cert-rotation verifier +
// applier surface alongside the engine, mirroring the per-domain
// re-exports below. One entry-point for every rotation surface.
export {
  applyCertRotationNotice,
  applyCertRotationRevertedEvent,
  signedBytesForCertRotationNotice,
  signedBytesForCertRotationReverted,
  verifyCertRotationNotice,
  verifyCertRotationRevertedEvent,
} from './cert-rotation-verifier.js';
export type {
  CertRotationApplyResult,
  CertRotationVerifyResult,
  PublicKeyResolver,
} from './cert-rotation-verifier.js';

// D-148 § A.6.5 — production bridge from substrate broadcast callbacks
// to the realtime event bus. Composed in `bin.ts` once the rotation
// engine itself is wired; ships ahead of that to keep substrate +
// emitter substrate in lockstep.
export {
  createCertRotationBroadcaster,
} from './cert-rotation-emitter.js';
export type {
  CertRotationBroadcaster,
  CertRotationBroadcasterOptions,
} from './cert-rotation-emitter.js';

// D-148 FU3 — re-export the per-domain two-pin rotation substrate so
// callers reach for ONE entry-point (`backend/server/src/keys/rotation`)
// for every rotation surface. Per-domain co-exists with the single-
// domain cluster-pin flow during W3.x.
export {
  createPerDomainRotationEngine,
  DEFAULT_DOMAIN_ROTATION_NOTICE_LEAD_MS,
} from './per-domain-rotation.js';
export type {
  PerDomainRotationEngine,
  PerDomainRotationEngineOptions,
  PerDomainRotationEffects,
  PerDomainRotationIdentityHook,
  PerDomainRotationStageOk,
  PerDomainRotationStageErr,
  PerDomainRotationStageResult,
  PerDomainRotationRevertOk,
  PerDomainRotationRevertErr,
  PerDomainRotationRevertResult,
} from './per-domain-rotation.js';
export {
  applyCertDomainRotationNotice,
  applyCertDomainRotationRevertedEvent,
  signedBytesForCertDomainRotationNotice,
  signedBytesForCertDomainRotationReverted,
  verifyCertDomainRotationNotice,
  verifyCertDomainRotationRevertedEvent,
} from './cert-domain-rotation-verifier.js';
export type {
  CertDomainRotationApplyResult,
  CertDomainRotationVerifyResult,
} from './cert-domain-rotation-verifier.js';
