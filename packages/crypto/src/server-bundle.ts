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
 *  Both wraps carry the SAME Master DEK; either factor opens it. That is an
 *  invariant, not a convention — `serverBundleAAD` binds each wrap to the
 *  bundle it was minted in, so a wrap carried over from a different bundle
 *  fails its tag rather than opening a second Master DEK. The
 *  bundle is NOT secret by itself (same as `Bundle`): it rides a filesystem
 *  sidecar beside the realm DB and travels in backups. The two secrets are the
 *  server key (in the keyfile) and the recovery key (in the user's head /
 *  on paper).
 *  A backup that includes the DB + bundle sidecar but NOT the keyfile stays
 *  encrypted; the recovery key is the only way back in from such a backup.
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

/** Bumped whenever a wrap or its binding changes shape. Old bundles are
 *  refused rather than migrated — pre-launch there is nothing in the field to
 *  carry forward, and a shim that opens both is a shim that can open the
 *  weaker one. */
export const SERVER_BUNDLE_VERSION = 2;

/** Server-key length — 32 bytes / 256 bits of CSPRNG output. Matches
 *  the Master DEK length; both are raw high-entropy keys. */
export const SERVER_KEY_LEN = DERIVED_KEY_LEN;

/** Bundle-identifier length — 16 bytes / 128 bits, so two independently minted
 *  bundles never collide. */
const BUNDLE_ID_LEN = 16;

/** On-wire server-bundle representation — safe to serialize as JSON into the
 *  realm sidecar / travel in a backup. All binary fields are base64. */
export interface ServerBundle {
  version: number;
  /** Random per-bundle identifier (base64). Not a secret: it exists only so
   *  the two wraps below can name the bundle they belong to. */
  bundle_id: string;
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

/** AAD bound to each wrapped Master DEK.
 *
 *  The bundle's own id is in there because the two wraps carrying the SAME
 *  Master DEK is an invariant something has to enforce. The bundle is not
 *  secret and rides a plain sidecar, so anyone holding two realms' backups can
 *  lift realm A's `salt_server` + `wrapped_server` into realm B's file. Without
 *  the id both halves authenticate cleanly and open DIFFERENT Master DEKs, and
 *  nothing notices: the server boots from the keyfile every time and only
 *  reaches for the recovery key once the machine is gone — which is the moment
 *  the realm turns out to be unrecoverable. With the id a foreign wrap fails
 *  its tag.
 *
 *  The field label keeps either ciphertext from being fed to the other's open
 *  path, and precedes the id so the encoding stays unambiguous whatever base64
 *  the id happens to contain. Versioned so the binding scheme can evolve.
 *  Distinct namespace from `bundle.ts`'s `recued/bundle/*`. */
const serverBundleAAD = (
  version: number,
  field: 'server' | 'rec',
  bundleId: string,
): Uint8Array =>
  new TextEncoder().encode(`recued/server-bundle/v${version}/${field}/${bundleId}`);

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
  const bundle_id = bytesToBase64(randomBytes(BUNDLE_ID_LEN));
  const salt_server = randomBytes(SALT_LEN);
  const salt_rec = randomBytes(SALT_LEN);

  const kek_server = deriveKEKFromServerKey(opts.serverKey, salt_server);
  const kek_rec = deriveKEKFromRecoveryKey(entropy, salt_rec);

  try {
    const wrapped_server = await encrypt(
      kek_server,
      masterDEK,
      serverBundleAAD(SERVER_BUNDLE_VERSION, 'server', bundle_id),
    );
    const wrapped_rec = await encrypt(
      kek_rec,
      masterDEK,
      serverBundleAAD(SERVER_BUNDLE_VERSION, 'rec', bundle_id),
    );

    const bundle: ServerBundle = {
      version: SERVER_BUNDLE_VERSION,
      bundle_id,
      salt_server: bytesToBase64(salt_server),
      salt_rec: bytesToBase64(salt_rec),
      wrapped_server: encodeCiphertext(wrapped_server),
      wrapped_rec: encodeCiphertext(wrapped_rec),
      updated_at: now(),
    };
    return { bundle, masterDEK };
  } finally {
    // Both KEKs and the mnemonic's entropy exist only to build the two wraps.
    // The Master DEK is the caller's — it goes back unlocked by design.
    entropy.fill(0);
    kek_server.fill(0);
    kek_rec.fill(0);
  }
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
  try {
    // `await` inside the try, not a bare `return` — the KEK is still in use
    // until the decrypt settles.
    return await decrypt(kek, ct, serverBundleAAD(bundle.version, 'server', bundle.bundle_id));
  } finally {
    kek.fill(0);
  }
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
  try {
    return await decrypt(kek, ct, serverBundleAAD(bundle.version, 'rec', bundle.bundle_id));
  } finally {
    // The caller owns `entropy` (the archive restore path reuses it); only the
    // KEK derived here is ours to clear.
    kek.fill(0);
  }
};

/** Open a server bundle with the 24-word recovery key (the
 *  disaster-recovery path). Returns the Master DEK. Throws on a wrong
 *  key, tampered bundle, or unsupported version. */
export const openServerBundleWithRecoveryKey = async (
  bundle: ServerBundle,
  recoveryKey: string,
): Promise<Uint8Array> => {
  // Bound, not inlined into the call: entropy derived here belongs to this
  // function, and an anonymous argument is one nothing can clear afterwards.
  const entropy = recoveryKeyToEntropy(recoveryKey);
  try {
    return await openServerBundleWithRecoveryEntropy(bundle, entropy);
  } finally {
    entropy.fill(0);
  }
};

/** Rebind only the normal-boot wrap to a destination machine's server key.
 * The recovery wrap and Master DEK remain byte-for-byte the same, so an archive
 * restore preserves the realm while making the restored sidecar bootable from
 * the destination keyfile. The recovery factor authenticates the operation.
 *
 * The bundle keeps its id: this is the same bundle rebound, not a new one, and
 * the untouched recovery wrap is bound to that id. Minting a fresh one would
 * leave the recovery factor unable to open its own bundle — the disaster-
 * recovery path broken by the operation meant to preserve it. */
export const rewrapServerBundleForServerKey = async (
  bundle: ServerBundle,
  recoveryEntropy: Uint8Array,
  serverKey: Uint8Array,
  options: { now?: () => number } = {},
): Promise<ServerBundle> => {
  assertSupportedVersion(bundle);
  if (serverKey.length !== SERVER_KEY_LEN) {
    throw new Error(`server-bundle: server key must be ${SERVER_KEY_LEN} bytes`);
  }

  const masterDEK = await openServerBundleWithRecoveryEntropy(bundle, recoveryEntropy);
  const saltServer = randomBytes(SALT_LEN);
  const kekServer = deriveKEKFromServerKey(serverKey, saltServer);
  try {
    const wrappedServer = await encrypt(
      kekServer,
      masterDEK,
      serverBundleAAD(bundle.version, 'server', bundle.bundle_id),
    );
    return {
      ...bundle,
      salt_server: bytesToBase64(saltServer),
      wrapped_server: encodeCiphertext(wrappedServer),
      updated_at: (options.now ?? Date.now)(),
    };
  } finally {
    masterDEK.fill(0);
    kekServer.fill(0);
  }
};

// ────────────────────────────────────────────────────────────────
// Serialization — JSON is the canonical at-rest form (filesystem sidecar).
// ────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS: (keyof ServerBundle)[] = [
  'version', 'bundle_id', 'salt_server', 'salt_rec', 'wrapped_server', 'wrapped_rec', 'updated_at',
];

const isServerBundleShape = (v: unknown): v is ServerBundle => {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in obj)) return false;
  }
  return (
    typeof obj.version === 'number' &&
    typeof obj.bundle_id === 'string' &&
    typeof obj.salt_server === 'string' &&
    typeof obj.salt_rec === 'string' &&
    typeof obj.wrapped_server === 'string' &&
    typeof obj.wrapped_rec === 'string' &&
    typeof obj.updated_at === 'number'
  );
};

/** Serialize a server bundle to JSON text. Stable key order, and every field
 *  named rather than spread — the projection is what keeps a bundle that picked
 *  up extra keys somewhere from carrying them into the sidecar. */
export const serverBundleToJSON = (bundle: ServerBundle): string => JSON.stringify({
  version: bundle.version,
  bundle_id: bundle.bundle_id,
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
