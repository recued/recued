/** Recovery-key check crypto — the KDF + AEAD-sealed sentinel pair
 *  the setup + entry primitives use to verify a typed key matches
 *  the one originally enrolled on this device.
 *
 *  Same shape across every surface that holds a local check (webclient
 *  pre-pair, bridge):
 *    deriveKekFromRecoveryKey(mnemonic) → CryptoKey
 *    buildRecoveryKeyCheck(kek)         → string (AEAD-sealed sentinel)
 *    verifyRecoveryKeyCheck(kek, blob)  → boolean (true on match)
 *
 *  Lifted from the extension's `sync/bundle-crypto.ts` at `c222acac^`.
 *  The wire format isn't preserved (pre-launch zero installs — no
 *  on-disk blobs exist in the wild), but the contract is identical so
 *  any host that stored a check via the old code path can be replaced
 *  by this one without renaming the storage key. */

import { deriveKeyFromPassphrase, encrypt, decrypt } from '@recued/storage';

/** Well-known salt. Public — does not weaken the scheme given the
 *  recovery key's 256-bit input entropy. Versioned so a future
 *  rotation of the KDF parameters doesn't break old checks. */
const KEK_SALT = 'recued-recovery-kek-v1';

/** Public sentinel encrypted as the recovery-key check. If decrypt
 *  + this plaintext compare succeeds, the recovery key is correct. */
const RECOVERY_SENTINEL = 'recued-recovery-check-v1';

interface SealedSentinel {
  ciphertext: string;
  iv: string;
}

/** Normalize a user-entered recovery key for KDF stability. Users
 *  may paste with extra whitespace, newlines, or different casing —
 *  mnemonic decoders treat these as equivalent, so we do too. Does
 *  NOT change individual word spelling, only surrounding whitespace
 *  + casing. */
const normalizeRecoveryKey = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ').toLowerCase();

/** Derive the recovery KEK from a user-entered mnemonic. Deterministic
 *  per (mnemonic) so re-deriving on later verify matches the value
 *  used on initial seal. PBKDF2 at 600k iterations; ~1s on modern
 *  hardware — acceptable once-per-pair cost. */
export const deriveKekFromRecoveryKey = async (
  recoveryKey: string,
): Promise<CryptoKey> => {
  const normalized = normalizeRecoveryKey(recoveryKey);
  // deriveKeyFromPassphrase takes a base64 salt + a passphrase. The
  // salt is a fixed ASCII string; btoa gives us its base64 encoding
  // without introducing a new encoding path.
  const saltB64 = btoa(KEK_SALT);
  return deriveKeyFromPassphrase(normalized, saltB64);
};

/** Produce the recovery-key check — an AEAD seal over a well-known
 *  sentinel. Verify tries to decrypt it; success means the recovery
 *  key is correct, failure means wrong key. */
export const buildRecoveryKeyCheck = async (kek: CryptoKey): Promise<string> => {
  const entry = await encrypt(kek, RECOVERY_SENTINEL);
  const sealed: SealedSentinel = { ciphertext: entry.ciphertext, iv: entry.iv };
  return JSON.stringify(sealed);
};

/** Verify a recovery-key check against a candidate KEK. Returns true
 *  when the KEK unwraps the sentinel; false on any failure (wrong
 *  key, tampered field, malformed JSON). Never throws. */
export const verifyRecoveryKeyCheck = async (
  kek: CryptoKey,
  check: string,
): Promise<boolean> => {
  let sealed: SealedSentinel;
  try {
    sealed = JSON.parse(check) as SealedSentinel;
    if (typeof sealed.ciphertext !== 'string' || typeof sealed.iv !== 'string') {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const plaintext = await decrypt(kek, {
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      created_at: 0,
      updated_at: 0,
    });
    return plaintext === RECOVERY_SENTINEL;
  } catch {
    return false;
  }
};
