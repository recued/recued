/** D-149 P3 § A.16.2 + § A.18.2 — Reception's server-secret pepper.
 *
 *  32-byte random value generated at first boot. Two consumer surfaces:
 *
 *    1. `hashSourceIpEndpointScoped` / `hashSourceIpServerWide` — HKDF
 *       salt for visitor-IP hashing (§ A.16.1). Endpoint-scoped by
 *       default; server-wide only when cross-endpoint analytics opt-in.
 *    2. `computeBearerHmac` — HMAC-SHA256 key for storing
 *       `bearer_secret_hmac` / `single_use_secret_hmac` (§ A.18.2 +
 *       § Must Hold I-10).
 *
 *  **Why a secret, not the server identity pubkey.** A draft design
 *  proposed using `server_identity_pubkey` as the salt — that's wrong:
 *  server identity public keys are *public* (Server Passport exports
 *  carry them; ACME issues certs against them). Anyone who knows the
 *  public key can replay the hash function and de-anonymize the access
 *  log. Pass-2 fix: pepper is server-internal, generated at first boot,
 *  stored in `master_dek`-protected secrets store per D-148 § A.8 sub_dek
 *  pattern.
 *
 *  **Storage path.** P3 derives the pepper via HKDF over the `reception`
 *  sub-DEK (one of the `SubDEKDomain` slots in `@recued/crypto`'s
 *  `kdf.ts`). The sub-DEK is itself derived from the FileVault-bound
 *  `master_dek` so:
 *
 *    - The pepper never persists on disk in plaintext — it lives only
 *      in process memory once derived.
 *    - The pepper survives process restarts (deterministic derivation
 *      from the same `master_dek`).
 *    - Rotating `master_dek` (D-148 key rotation) automatically rotates
 *      the pepper — a `pepper_rotation` audit row pins the transition.
 *    - The pepper depends on the unlocked vault. The reception listener
 *      refuses requests when the vault is locked — fail-loud rather
 *      than silently fall back to a weaker hash.
 *
 *  **Independent of `server_identity_key`.** D-148 P2's `ServerKeyStore`
 *  holds the Ed25519 signing key; the pepper lives in a different sub-
 *  DEK slot derived from a different master. Compromising one does not
 *  leak the other.
 *
 *  Spec: `docs/d-149-spec.md` § A.16.2 + § A.18.2 + § Open question (2). */

import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { deriveSubDEK } from '@recued/crypto';

/** Byte length of the pepper. 32 bytes ⇒ 256 bits ⇒ matches the
 *  HMAC-SHA256 key length + matches the HKDF info-derivation output
 *  for `source_ip_hash`. */
export const RECEPTION_PEPPER_BYTE_LENGTH = 32;

/** Domain-separation label for the pepper-derivation HKDF info. Stable
 *  across boots; never recycled. Adding a new pepper-domain = new label
 *  here. */
const PEPPER_HKDF_INFO = 'recued/v1/reception/pepper';

/** Domain-separation labels for the per-IP-hash HKDF call. The
 *  endpoint-scoped variant includes the endpoint_id in the info; the
 *  server-wide variant uses the bare `server_wide` literal. */
const ENDPOINT_SCOPED_IP_INFO_PREFIX = 'recued/v1/reception/source_ip/endpoint/';
const SERVER_WIDE_IP_INFO = 'recued/v1/reception/source_ip/server_wide';

/** Derive the pepper directly from the `reception` sub-DEK. Production
 *  bin.ts holds the sub-DEK via `KeyManager.keyProvider('reception')`
 *  (the master DEK never leaves the manager); call this instead of the
 *  master-DEK-keyed variant below to avoid re-deriving the sub-DEK at
 *  every pepper read. Pure-fn; same input produces same output. */
export const deriveReceptionPepperFromSubDek = (
  reception_sub_dek: Uint8Array | Buffer,
): Buffer => {
  if (reception_sub_dek.length !== 32) {
    throw new Error(
      `deriveReceptionPepperFromSubDek: sub_dek must be 32 bytes; got ${reception_sub_dek.length}`,
    );
  }
  // HKDF the pepper from the sub-DEK with a distinct info label. This
  // hop keeps the pepper logically distinct from any future reception
  // sub-DEK consumer (e.g., a sub-DEK-encrypted
  // `consumed_by_visitor_email_encrypted` PII column).
  const pepperBytes = hkdfSync(
    'sha256',
    Buffer.from(reception_sub_dek),
    Buffer.alloc(0),
    Buffer.from(PEPPER_HKDF_INFO, 'utf8'),
    RECEPTION_PEPPER_BYTE_LENGTH,
  );
  return Buffer.from(pepperBytes);
};

/** Derive the Reception pepper from a master DEK. Pure-fn; same input
 *  produces same output. Caller supplies the unlocked `master_dek`.
 *  Test-side helper; production wiring uses
 *  `deriveReceptionPepperFromSubDek` so the master DEK never leaves the
 *  KeyManager. */
export const deriveReceptionPepper = (master_dek: Buffer): Buffer => {
  if (master_dek.length !== 32) {
    throw new Error(
      `deriveReceptionPepper: master_dek must be 32 bytes; got ${master_dek.length}`,
    );
  }
  // Step 1: derive the `reception` sub-DEK from master via HKDF
  // (one of the closed `SubDEKDomain` slots in @recued/crypto/kdf.ts).
  const subDek = deriveSubDEK(new Uint8Array(master_dek), 'reception');
  // Step 2: HKDF the pepper out of the sub-DEK. Implemented via the
  // sub-DEK-keyed helper so production + tests share one HKDF call site.
  return deriveReceptionPepperFromSubDek(subDek);
};

/** § A.16.1 — endpoint-scoped HKDF over the visitor source IP. Same
 *  visitor at different endpoints produces *different* hashes by
 *  construction (the `info` parameter varies on `endpoint_id`). */
export const hashSourceIpEndpointScoped = (
  ip: string,
  endpoint_id: string,
  pepper: Buffer,
): string => {
  if (pepper.length !== RECEPTION_PEPPER_BYTE_LENGTH) {
    throw new Error(
      `hashSourceIpEndpointScoped: pepper must be ${RECEPTION_PEPPER_BYTE_LENGTH} bytes`,
    );
  }
  if (typeof ip !== 'string' || ip.length === 0) {
    throw new Error('hashSourceIpEndpointScoped: ip must be a non-empty string');
  }
  if (typeof endpoint_id !== 'string' || endpoint_id.length === 0) {
    throw new Error('hashSourceIpEndpointScoped: endpoint_id must be a non-empty string');
  }
  const hashBytes = hkdfSync(
    'sha256',
    Buffer.from(ip, 'utf8'),
    pepper,
    Buffer.from(ENDPOINT_SCOPED_IP_INFO_PREFIX + endpoint_id, 'utf8'),
    RECEPTION_PEPPER_BYTE_LENGTH,
  );
  return Buffer.from(hashBytes).toString('base64url');
};

/** § A.16.1 — server-wide HKDF over the visitor source IP. Same visitor
 *  at *any* endpoint produces the *same* hash; only used when
 *  cross-endpoint analytics opt-in (§ A.16.4) is on. */
export const hashSourceIpServerWide = (ip: string, pepper: Buffer): string => {
  if (pepper.length !== RECEPTION_PEPPER_BYTE_LENGTH) {
    throw new Error(
      `hashSourceIpServerWide: pepper must be ${RECEPTION_PEPPER_BYTE_LENGTH} bytes`,
    );
  }
  if (typeof ip !== 'string' || ip.length === 0) {
    throw new Error('hashSourceIpServerWide: ip must be a non-empty string');
  }
  const hashBytes = hkdfSync(
    'sha256',
    Buffer.from(ip, 'utf8'),
    pepper,
    Buffer.from(SERVER_WIDE_IP_INFO, 'utf8'),
    RECEPTION_PEPPER_BYTE_LENGTH,
  );
  return Buffer.from(hashBytes).toString('base64url');
};

/** § A.18.2 + § Must Hold I-10 — HMAC-SHA256(pepper, secret) over a
 *  random 256-bit bearer. Returns the 32-byte binary HMAC for storage
 *  in `public_endpoint_registry.bearer_secret_hmac`. */
export const computeBearerHmac = (bearer_secret: string, pepper: Buffer): Buffer => {
  if (pepper.length !== RECEPTION_PEPPER_BYTE_LENGTH) {
    throw new Error(
      `computeBearerHmac: pepper must be ${RECEPTION_PEPPER_BYTE_LENGTH} bytes`,
    );
  }
  if (typeof bearer_secret !== 'string' || bearer_secret.length === 0) {
    throw new Error('computeBearerHmac: bearer_secret must be a non-empty string');
  }
  return createHmac('sha256', pepper).update(bearer_secret, 'utf8').digest();
};

/** Derivation-trace probe for debugging. Returns a sha256 of the pepper
 *  so an operator can compare pepper identity across two contexts
 *  without exfiltrating the pepper itself. Never logs the pepper. */
export const peeperFingerprint = (pepper: Buffer): string =>
  createHash('sha256').update(pepper).digest('hex').slice(0, 16);
