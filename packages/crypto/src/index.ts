// KDF primitives
export {
  deriveKEKFromPassword,
  deriveKEKFromRecoveryKey,
  deriveKEKFromServerKey,
  deriveSubDEK,
  randomBytes,
  DEFAULT_ARGON2_PARAMS,
  DERIVED_KEY_LEN,
  SALT_LEN,
  type Argon2Params,
  type SubDEKDomain,
} from './kdf.js';

// Authenticated encryption
export {
  encrypt,
  decrypt,
  encodeCiphertext,
  decodeCiphertext,
  bytesToBase64,
  base64ToBytes,
  type Ciphertext,
} from './aead.js';

// Recovery key (24-word BIP39)
export {
  generateRecoveryKey,
  recoveryKeyToEntropy,
  isValidRecoveryKey,
  RECOVERY_KEY_WORD_COUNT,
} from './recovery.js';

// Bundle — the FileVault unit
export {
  createBundle,
  openBundle,
  openBundleWithPassword,
  openBundleWithRecoveryKey,
  openBundleWithRecoveryEntropy,
  rotatePassword,
  rotateRecoveryKey,
  BUNDLE_VERSION,
  type Bundle,
} from './bundle.js';

// Serialization (JSON, file, QR)
export {
  bundleToJSON,
  bundleFromJSON,
  bundleToQR,
  bundleFromQR,
  bundleToFile,
  bundleFromFile,
  QR_SCHEME,
  FILE_HEADER,
} from './serialize.js';

// Server vault bundle — server-key (keyfile auto-unlock) + recovery-key
// (disaster-recovery) dual-wrap of the Master DEK for self-hosted servers
export {
  createServerBundle,
  openServerBundleWithServerKey,
  openServerBundleWithRecoveryKey,
  openServerBundleWithRecoveryEntropy,
  generateServerKey,
  serverBundleToJSON,
  serverBundleFromJSON,
  SERVER_BUNDLE_VERSION,
  SERVER_KEY_LEN,
  type ServerBundle,
} from './server-bundle.js';

// Canonical JSON for signing + verification
export {
  canonicalJSONStringify,
  canonicalJSONStringifyStrict,
} from './canonical-json.js';

// SHA-256 hex digest (isomorphic, @noble-backed)
export { sha256Hex } from './hash.js';
