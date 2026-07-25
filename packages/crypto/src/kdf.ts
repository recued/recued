/** Key-derivation functions for the FileVault model.
 *
 *  Three primitives:
 *    - Argon2id(password, salt_pw, params) → KEK_pw
 *      The slow, memory-hard derivation that makes password brute force
 *      expensive. Params are stored in the bundle so each user's cost
 *      can evolve over time without breaking old bundles.
 *
 *    - HKDF(recovery_key, salt_rec) → KEK_rec
 *      The recovery key is already high-entropy (256 bits from
 *      crypto.getRandomValues), so HKDF suffices — no Argon2 pass needed.
 *
 *    - HKDF(master_dek, domain_label) → sub_dek
 *      Domain separation: each at-rest surface (server-data, blob-store,
 *      ext-cache, cloud-sync, vault) gets its own derived key from the
 *      same Master DEK. Compromising one sub-DEK does not leak others.
 *
 *  Portability: @noble/hashes is pure JS and runs identically in Node
 *  and the browser. Don't introduce a native-binding Argon2 here — that
 *  would break the ext build.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export interface Argon2Params {
  /** Time cost — iterations. Default 3 per OWASP 2024. */
  t: number;
  /** Memory cost — kibibytes. Default 65536 (64 MiB). */
  m: number;
  /** Parallelization parameter. Default 4. */
  p: number;
}

/** Default Argon2id cost parameters. OWASP 2024 recommendation for
 *  interactive login flows: 64 MiB, 3 iterations, 4 parallelism lanes.
 *  Override at your own risk — dropping any of these materially weakens
 *  password security. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = Object.freeze({
  t: 3,
  m: 65536,
  p: 4,
});

/** Derived key length, bytes. 32 → 256 bits → AES-256 key. */
export const DERIVED_KEY_LEN = 32;

/** Salt length for password + recovery-key KDFs. 16 bytes = 128 bits
 *  is standard; no need for more. */
export const SALT_LEN = 16;

/** HKDF domain-separation labels for sub-DEK derivation. Each surface
 *  gets its own label. Adding a new surface means adding a new label;
 *  labels are stable and never recycled. `account` (D-100) joins the
 *  set for account-namespace ciphertext — historical slot; D-125 P5.2
 *  retired the runtime. `connection` (D-125 P2.2) joins for the
 *  connection-namespace ciphertext — outbound endpoint records (mcp /
 *  api / notification) whose `auth` field encrypts at-rest under this
 *  sub-DEK and rides the same opaque ciphertext over the pair-sync
 *  WS rpc. Both sides of the pair derive the same sub-DEK from the
 *  FileVault-bound Master DEK so the blob round-trips server → paired
 *  client without any cloud hop (D-168 retired cloud sync entirely;
 *  pair sync is server-to-paired-client only). `chat` (D-137 P1.2) joins for
 *  the AI Chat substrate's `chat_messages.content_encrypted` blob —
 *  per-turn message body encrypted at rest under a dedicated domain so
 *  a key compromise of one surface doesn't broaden the blast radius
 *  into the other. Per-pair only; never broadcast cross-cloud (D-097
 *  / D-168 — chat history stays local to the paired server). */
export type SubDEKDomain =
  | 'database'
  | 'server-data'
  | 'blob-store'
  | 'ext-cache'
  | 'cloud-sync'
  | 'vault'
  | 'account'
  | 'connection'
  | 'chat'
  | 'tls_domains'
  // D-201 Slice 1 — inbound webhook profile credentials. Deliberately
  // independent from outbound connection auth: compromise of a connection
  // token must not decrypt callback signing secrets (or vice versa).
  | 'webhook_secrets'
  // D-201 Slice 2 — decoded admitted payloads are untrusted retained data,
  // separated from the endpoint credentials that authenticated them.
  | 'webhook_payloads'
  // D-149 P3 § A.16.2 — Reception's server-secret pepper. HKDF-keyed
  // input to the `hashSourceIpEndpointScoped` + `hashSourceIpServerWide`
  // source-IP hashes (per § A.16.1) AND to the HMAC-SHA256 store for
  // `bearer_secret_hmac` / `single_use_secret_hmac` (per § A.18.2 +
  // § Must Hold I-10). Independent of `server_identity_key` (which is
  // public — visible to all paired clients via Server Passport); the
  // pepper is server-internal. Per-pair only; never broadcast
  // cross-cloud (D-097 / D-168 — reception substrate is
  // server-internal per § Must Hold I-15).
  | 'reception';

/** Derive KEK from a user password via Argon2id. Async because Argon2
 *  is deliberately slow — we never want to block the event loop. */
export const deriveKEKFromPassword = async (
  password: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<Uint8Array> => {
  if (password.length === 0) {
    throw new Error('kdf: password must be non-empty');
  }
  if (salt.length !== SALT_LEN) {
    throw new Error(`kdf: password salt must be ${SALT_LEN} bytes`);
  }
  return argon2idAsync(password, salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: DERIVED_KEY_LEN,
  });
};

/** Derive KEK from a high-entropy recovery key via HKDF-SHA-256.
 *  The recovery key itself is 32 bytes of CSPRNG output, so HKDF is
 *  enough — no need for a slow KDF. */
export const deriveKEKFromRecoveryKey = (
  recoveryKey: Uint8Array,
  salt: Uint8Array,
): Uint8Array => {
  if (recoveryKey.length !== DERIVED_KEY_LEN) {
    throw new Error(`kdf: recovery key must be ${DERIVED_KEY_LEN} bytes`);
  }
  if (salt.length !== SALT_LEN) {
    throw new Error(`kdf: recovery salt must be ${SALT_LEN} bytes`);
  }
  return hkdf(
    sha256,
    recoveryKey,
    salt,
    new TextEncoder().encode('recued/v1/recovery-kek'),
    DERIVED_KEY_LEN,
  );
};

/** Derive KEK from a high-entropy server key via HKDF-SHA-256.
 *  The server key is 32 bytes of CSPRNG output (persisted in the
 *  server's 0600 keyfile), so — like the recovery key — HKDF is enough;
 *  no slow KDF. This is the factor that lets a headless server
 *  auto-unlock its own Master DEK at boot without a human. Distinct
 *  domain label from the recovery-key KEK so the two never collide. */
export const deriveKEKFromServerKey = (
  serverKey: Uint8Array,
  salt: Uint8Array,
): Uint8Array => {
  if (serverKey.length !== DERIVED_KEY_LEN) {
    throw new Error(`kdf: server key must be ${DERIVED_KEY_LEN} bytes`);
  }
  if (salt.length !== SALT_LEN) {
    throw new Error(`kdf: server salt must be ${SALT_LEN} bytes`);
  }
  return hkdf(
    sha256,
    serverKey,
    salt,
    new TextEncoder().encode('recued/v1/server-kek'),
    DERIVED_KEY_LEN,
  );
};

/** Derive a domain-separated sub-DEK from the Master DEK.
 *  Each surface (server-data, blob-store, etc.) gets its own sub-DEK
 *  via a distinct HKDF label. */
export const deriveSubDEK = (
  masterDEK: Uint8Array,
  domain: SubDEKDomain,
): Uint8Array => {
  if (masterDEK.length !== DERIVED_KEY_LEN) {
    throw new Error(`kdf: master DEK must be ${DERIVED_KEY_LEN} bytes`);
  }
  return hkdf(
    sha256,
    masterDEK,
    undefined,
    new TextEncoder().encode(`recued/v1/sub-dek/${domain}`),
    DERIVED_KEY_LEN,
  );
};

/** Generate cryptographically-secure random bytes. Uses Web Crypto
 *  `getRandomValues` which is present in Node 18+ and all browsers. */
export const randomBytes = (n: number): Uint8Array => {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
};
