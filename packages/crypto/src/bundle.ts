/** Crypto bundle — the portable unit of the FileVault model.
 *
 *  A ~200-byte structure that anyone with the password (or recovery key)
 *  can open to recover the Master DEK. The Master DEK itself never leaves
 *  the user's machine unwrapped — it's wrapped twice (password + recovery
 *  key), and both wraps live in the bundle.
 *
 *  Bundle is not secret by itself. It's designed to travel — via pairing
 *  WS, PRO cloud row, QR code, file export. Cloud compromise alone gets
 *  nothing without the password or recovery key.
 *
 *  Operations:
 *    createBundle({ password })        → { bundle, recoveryKey }
 *    openBundle(bundle, { password })  → Master DEK
 *    openBundle(bundle, { recoveryKey }) → Master DEK
 *    rotatePassword(bundle, oldPw, newPw) → new bundle
 *    rotateRecoveryKey(bundle, password) → { newBundle, newRecoveryKey }
 */

import { encrypt, decrypt, encodeCiphertext, decodeCiphertext, bytesToBase64, base64ToBytes } from './aead.js';
import {
  deriveKEKFromPassword,
  deriveKEKFromRecoveryKey,
  randomBytes,
  DEFAULT_ARGON2_PARAMS,
  DERIVED_KEY_LEN,
  SALT_LEN,
  type Argon2Params,
} from './kdf.js';
import { generateRecoveryKey, recoveryKeyToEntropy } from './recovery.js';

export const BUNDLE_VERSION = 1;

/** On-wire bundle representation — safe to serialize as JSON and travel
 *  over any channel. All binary fields are base64. */
export interface Bundle {
  version: number;
  argon2: Argon2Params;
  /** Argon2 salt for password KEK. */
  salt_pw: string;
  /** HKDF salt for recovery-key KEK. */
  salt_rec: string;
  /** Master DEK wrapped under KEK_pw. */
  wrapped_pw: string;
  /** Master DEK wrapped under KEK_rec. */
  wrapped_rec: string;
  /** Epoch ms — bumps on any rotation. */
  updated_at: number;
}

/** AAD bound to the wrapped Master DEK. Prevents a wrap from one bundle
 *  being spliced into another. Versioned so we can evolve the binding
 *  scheme without breaking old bundles. */
const bundleAAD = (version: number, field: 'pw' | 'rec'): Uint8Array =>
  new TextEncoder().encode(`recued/bundle/v${version}/${field}`);

/** Create a fresh bundle from a password. Generates a random Master DEK
 *  + a random recovery key; wraps the Master DEK under both KEKs. */
export const createBundle = async (
  opts: { password: string; argon2?: Argon2Params; now?: () => number },
): Promise<{ bundle: Bundle; recoveryKey: string; masterDEK: Uint8Array }> => {
  if (!opts.password || opts.password.length === 0) {
    throw new Error('bundle: password is required');
  }
  const argon2 = opts.argon2 ?? DEFAULT_ARGON2_PARAMS;
  const now = opts.now ?? (() => Date.now());

  const masterDEK = randomBytes(DERIVED_KEY_LEN);
  const { mnemonic, entropy } = generateRecoveryKey();

  const salt_pw = randomBytes(SALT_LEN);
  const salt_rec = randomBytes(SALT_LEN);

  const kek_pw = await deriveKEKFromPassword(opts.password, salt_pw, argon2);
  const kek_rec = deriveKEKFromRecoveryKey(entropy, salt_rec);

  const wrapped_pw = await encrypt(kek_pw, masterDEK, bundleAAD(BUNDLE_VERSION, 'pw'));
  const wrapped_rec = await encrypt(kek_rec, masterDEK, bundleAAD(BUNDLE_VERSION, 'rec'));

  const bundle: Bundle = {
    version: BUNDLE_VERSION,
    argon2,
    salt_pw: bytesToBase64(salt_pw),
    salt_rec: bytesToBase64(salt_rec),
    wrapped_pw: encodeCiphertext(wrapped_pw),
    wrapped_rec: encodeCiphertext(wrapped_rec),
    updated_at: now(),
  };
  return { bundle, recoveryKey: mnemonic, masterDEK };
};

const assertSupportedVersion = (bundle: Bundle): void => {
  if (bundle.version !== BUNDLE_VERSION) {
    throw new Error(`bundle: unsupported version ${bundle.version} (this build supports v${BUNDLE_VERSION})`);
  }
};

/** Open a bundle with a password. Returns the Master DEK. Throws on
 *  wrong password, tampered bundle, or unsupported version. */
export const openBundleWithPassword = async (
  bundle: Bundle,
  password: string,
): Promise<Uint8Array> => {
  assertSupportedVersion(bundle);
  const salt_pw = base64ToBytes(bundle.salt_pw);
  const kek_pw = await deriveKEKFromPassword(password, salt_pw, bundle.argon2);
  const ct = decodeCiphertext(bundle.wrapped_pw);
  return decrypt(kek_pw, ct, bundleAAD(bundle.version, 'pw'));
};

/** Open a bundle with the raw 32-byte recovery ENTROPY (i.e.
 *  `recoveryKeyToEntropy(mnemonic)`) — the sibling of
 *  `openServerBundleWithRecoveryEntropy` for the legacy bundle, for callers
 *  that hold the derived entropy rather than the mnemonic (the archive restore
 *  path). */
export const openBundleWithRecoveryEntropy = async (
  bundle: Bundle,
  entropy: Uint8Array,
): Promise<Uint8Array> => {
  assertSupportedVersion(bundle);
  const salt_rec = base64ToBytes(bundle.salt_rec);
  const kek_rec = deriveKEKFromRecoveryKey(entropy, salt_rec);
  const ct = decodeCiphertext(bundle.wrapped_rec);
  return decrypt(kek_rec, ct, bundleAAD(bundle.version, 'rec'));
};

/** Open a bundle with a recovery key (24-word mnemonic). */
export const openBundleWithRecoveryKey = async (
  bundle: Bundle,
  recoveryKey: string,
): Promise<Uint8Array> =>
  openBundleWithRecoveryEntropy(bundle, recoveryKeyToEntropy(recoveryKey));

/** Convenience wrapper accepting either credential. */
export const openBundle = async (
  bundle: Bundle,
  creds: { password?: string; recoveryKey?: string },
): Promise<Uint8Array> => {
  if (creds.password) return openBundleWithPassword(bundle, creds.password);
  if (creds.recoveryKey) return openBundleWithRecoveryKey(bundle, creds.recoveryKey);
  throw new Error('bundle: one of { password, recoveryKey } is required');
};

/** Rotate the password wrap. Re-wraps the Master DEK under a fresh
 *  KEK_pw; recovery wrap is untouched. Bumps updated_at. */
export const rotatePassword = async (
  bundle: Bundle,
  oldPassword: string,
  newPassword: string,
  opts: { argon2?: Argon2Params; now?: () => number } = {},
): Promise<Bundle> => {
  if (!newPassword || newPassword.length === 0) {
    throw new Error('bundle: newPassword is required');
  }
  const now = opts.now ?? (() => Date.now());
  const masterDEK = await openBundleWithPassword(bundle, oldPassword);
  const argon2 = opts.argon2 ?? bundle.argon2;
  const salt_pw = randomBytes(SALT_LEN);
  const kek_pw = await deriveKEKFromPassword(newPassword, salt_pw, argon2);
  const wrapped_pw = await encrypt(kek_pw, masterDEK, bundleAAD(bundle.version, 'pw'));

  // Zero the Master DEK copy that was transiently in this closure. The
  // wrapped_pw / wrapped_rec hold the only lingering copies now.
  masterDEK.fill(0);

  return {
    ...bundle,
    argon2,
    salt_pw: bytesToBase64(salt_pw),
    wrapped_pw: encodeCiphertext(wrapped_pw),
    updated_at: now(),
  };
};

/** Rotate the recovery key. Generates a fresh 24-word mnemonic, re-wraps
 *  under it. Password wrap untouched. */
export const rotateRecoveryKey = async (
  bundle: Bundle,
  password: string,
  opts: { now?: () => number } = {},
): Promise<{ bundle: Bundle; recoveryKey: string }> => {
  const now = opts.now ?? (() => Date.now());
  const masterDEK = await openBundleWithPassword(bundle, password);
  const { mnemonic, entropy } = generateRecoveryKey();
  const salt_rec = randomBytes(SALT_LEN);
  const kek_rec = deriveKEKFromRecoveryKey(entropy, salt_rec);
  const wrapped_rec = await encrypt(kek_rec, masterDEK, bundleAAD(bundle.version, 'rec'));

  masterDEK.fill(0);

  const next: Bundle = {
    ...bundle,
    salt_rec: bytesToBase64(salt_rec),
    wrapped_rec: encodeCiphertext(wrapped_rec),
    updated_at: now(),
  };
  return { bundle: next, recoveryKey: mnemonic };
};
