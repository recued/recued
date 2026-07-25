/** Server vault bundle — the "encryption is actually on" unit for a
 *  self-hosted recued-server.
 *
 *  Unlike the FileVault `Bundle` (password + recovery key, `bundle.ts`),
 *  the server vault bundle wraps the Master DEK under two HIGH-ENTROPY
 *  factors, so BOTH use HKDF (no Argon2 — neither factor is a
 *  human-chosen password):
 *
 *    - **server key** — a random 32-byte secret the server persists in
 *      its `0600` keyfile (`keys/file-store.ts`), separate from the
 *      SQLite DB. This is what lets a headless server AUTO-UNLOCK its
 *      own Master DEK on every boot — cron / webhooks / housekeeping run
 *      with no human present. (`wrapped_server`)
 *
 *    - **recovery key** — the user's 24-word BIP39 phrase, supplied once
 *      at first-boot enrollment. The DISASTER-RECOVERY anchor: it
 *      restores the Master DEK onto a NEW machine from a backup when the
 *      server (and its keyfile) is lost. Never needed to run — only to
 *      recover. This is why writing it down matters. (`wrapped_rec`)
 *
 *  Both wraps carry the SAME Master DEK; either factor opens it. The
 *  bundle is NOT secret by itself (same as `Bundle`): it rides the
 *  SQLite DB and travels in backups. The two secrets are the server key
 *  (in the keyfile) and the recovery key (in the user's head / on paper).
 *  A backup that includes the DB but NOT the keyfile stays encrypted;
 *  the recovery key is the only way back in from such a backup.
 */

import {
  encrypt,
  decrypt,
  encodeCiphertext,
  decodeCiphertext,
  bytesToBase64,
  base64ToBytes,
} from './aead.js';
import {
  deriveKEKFromServerKey,
  deriveKEKFromRecoveryKey,
  randomBytes,
  DERIVED_KEY_LEN,
  SALT_LEN,
} from './kdf.js';
import { recoveryKeyToEntropy } from './recovery.js';

export const SERVER_BUNDLE_VERSION = 1;

/** Server-key length — 32 bytes / 256 bits of CSPRNG output. Matches
 *  the Master DEK length; both are raw high-entropy keys. */
export const SERVER_KEY_LEN = DERIVED_KEY_LEN;

/** On-wire server-bundle representation — safe to serialize as JSON and
 *  store in SQLite / travel in a backup. All binary fields are base64. */
export interface ServerBundle {
  version: number;
  /** HKDF salt for the server-key KEK (base64). */
  salt_server: string;
  /** HKDF salt for the recovery-key KEK (base64). */
  salt_rec: string;
  /** Master DEK wrapped under KEK_server (keyfile auto-unlock). */
  wrapped_server: string;
  /** Master DEK wrapped under KEK_rec (disaster-recovery anchor). */
  wrapped_rec: string;
  /** Epoch ms — bumps on any rotation. */
  updated_at: number;
}

/** AAD bound to each wrapped Master DEK. Prevents one bundle's wrap
 *  being spliced into another, and prevents the server-wrap ciphertext
 *  from being fed to the recovery-open path (distinct field label).
 *  Versioned so the binding scheme can evolve without breaking old
 *  bundles. Distinct namespace from `bundle.ts`'s `recued/bundle/*`. */
const serverBundleAAD = (version: number, field: 'server' | 'rec'): Uint8Array =>
  new TextEncoder().encode(`recued/server-bundle/v${version}/${field}`);

/** Generate a fresh 32-byte server key. The caller persists it in the
 *  keyfile; it is the auto-unlock secret. Exposed so the enrollment
 *  path mints it with the same CSPRNG the bundle uses. */
export const generateServerKey = (): Uint8Array => randomBytes(SERVER_KEY_LEN);

const assertSupportedVersion = (bundle: ServerBundle): void => {
  if (bundle.version !== SERVER_BUNDLE_VERSION) {
    throw new Error(
      `server-bundle: unsupported version ${bundle.version} (this build supports v${SERVER_BUNDLE_VERSION})`,
    );
  }
};

/** Create a fresh server vault bundle. Generates a random Master DEK and
 *  wraps it under both the server key and the (user-supplied) recovery
 *  key. Returns the Master DEK so the caller can enter the unlocked
 *  state without re-opening. Throws if the recovery key is not a valid
 *  24-word BIP39 mnemonic, or the server key is the wrong length. */
export const createServerBundle = async (
  opts: { recoveryKey: string; serverKey: Uint8Array; now?: () => number },
): Promise<{ bundle: ServerBundle; masterDEK: Uint8Array }> => {
  if (opts.serverKey.length !== SERVER_KEY_LEN) {
    throw new Error(`server-bundle: server key must be ${SERVER_KEY_LEN} bytes`);
  }
  // Throws on a malformed / bad-checksum mnemonic before any key material
  // is generated — a bad recovery key must not produce a half-built bundle.
  const entropy = recoveryKeyToEntropy(opts.recoveryKey);
  const now = opts.now ?? (() => Date.now());

  const masterDEK = randomBytes(DERIVED_KEY_LEN);
  const salt_server = randomBytes(SALT_LEN);
  const salt_rec = randomBytes(SALT_LEN);

  const kek_server = deriveKEKFromServerKey(opts.serverKey, salt_server);
  const kek_rec = deriveKEKFromRecoveryKey(entropy, salt_rec);

  const wrapped_server = await encrypt(
    kek_server,
    masterDEK,
    serverBundleAAD(SERVER_BUNDLE_VERSION, 'server'),
  );
  const wrapped_rec = await encrypt(
    kek_rec,
    masterDEK,
    serverBundleAAD(SERVER_BUNDLE_VERSION, 'rec'),
  );

  const bundle: ServerBundle = {
    version: SERVER_BUNDLE_VERSION,
    salt_server: bytesToBase64(salt_server),
    salt_rec: bytesToBase64(salt_rec),
    wrapped_server: encodeCiphertext(wrapped_server),
    wrapped_rec: encodeCiphertext(wrapped_rec),
    updated_at: now(),
  };
  return { bundle, masterDEK };
};

/** Open a server bundle with the server key (the boot auto-unlock path).
 *  Returns the Master DEK. Throws on a wrong key, tampered bundle, or
 *  unsupported version. */
export const openServerBundleWithServerKey = async (
  bundle: ServerBundle,
  serverKey: Uint8Array,
): Promise<Uint8Array> => {
  assertSupportedVersion(bundle);
  if (serverKey.length !== SERVER_KEY_LEN) {
    throw new Error(`server-bundle: server key must be ${SERVER_KEY_LEN} bytes`);
  }
  const salt = base64ToBytes(bundle.salt_server);
  const kek = deriveKEKFromServerKey(serverKey, salt);
  const ct = decodeCiphertext(bundle.wrapped_server);
  return decrypt(kek, ct, serverBundleAAD(bundle.version, 'server'));
};

/** Open a server bundle with the raw 32-byte recovery ENTROPY (i.e.
 *  `recoveryKeyToEntropy(mnemonic)`), for callers that already hold the derived
 *  entropy rather than the 24-word mnemonic — e.g. the archive restore path,
 *  where `ImportOptions.recoveryKey` is the entropy. Returns the Master DEK.
 *  Throws on a wrong key, tampered bundle, or unsupported version. */
export const openServerBundleWithRecoveryEntropy = async (
  bundle: ServerBundle,
  entropy: Uint8Array,
): Promise<Uint8Array> => {
  assertSupportedVersion(bundle);
  const salt = base64ToBytes(bundle.salt_rec);
  const kek = deriveKEKFromRecoveryKey(entropy, salt);
  const ct = decodeCiphertext(bundle.wrapped_rec);
  return decrypt(kek, ct, serverBundleAAD(bundle.version, 'rec'));
};

/** Open a server bundle with the 24-word recovery key (the
 *  disaster-recovery path). Returns the Master DEK. Throws on a wrong
 *  key, tampered bundle, or unsupported version. */
export const openServerBundleWithRecoveryKey = async (
  bundle: ServerBundle,
  recoveryKey: string,
): Promise<Uint8Array> =>
  openServerBundleWithRecoveryEntropy(bundle, recoveryKeyToEntropy(recoveryKey));

// ────────────────────────────────────────────────────────────────
// Serialization — JSON is the canonical at-rest form (SQLite row).
// ────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS: (keyof ServerBundle)[] = [
  'version', 'salt_server', 'salt_rec', 'wrapped_server', 'wrapped_rec', 'updated_at',
];

const isServerBundleShape = (v: unknown): v is ServerBundle => {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in obj)) return false;
  }
  return (
    typeof obj.version === 'number' &&
    typeof obj.salt_server === 'string' &&
    typeof obj.salt_rec === 'string' &&
    typeof obj.wrapped_server === 'string' &&
    typeof obj.wrapped_rec === 'string' &&
    typeof obj.updated_at === 'number'
  );
};

/** Serialize a server bundle to JSON text. Stable key order. */
export const serverBundleToJSON = (bundle: ServerBundle): string => JSON.stringify({
  version: bundle.version,
  salt_server: bundle.salt_server,
  salt_rec: bundle.salt_rec,
  wrapped_server: bundle.wrapped_server,
  wrapped_rec: bundle.wrapped_rec,
  updated_at: bundle.updated_at,
});

export const serverBundleFromJSON = (json: string): ServerBundle => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('server-bundle: JSON is malformed');
  }
  if (!isServerBundleShape(parsed)) {
    throw new Error('server-bundle: JSON is missing required fields');
  }
  return parsed;
};
