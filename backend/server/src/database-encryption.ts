/** D-212 database-key derivation and first-enrollment crash marker.
 *
 * The SQLite file is keyed with its own HKDF-separated sub-DEK. The Master DEK
 * remains dual-wrapped in the db-adjacent server-bundle sidecar, so either the
 * keyfile-held server key (normal boot) or the recovery key (restore/offline
 * recovery) can derive the exact same database key.
 */

import {
  closeSync,
  existsSync,
  statSync,
  fsyncSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  deriveSubDEK,
  generateServerKey,
  openServerBundleWithRecoveryEntropy,
  openServerBundleWithServerKey,
  rewrapServerBundleForServerKey,
  type ServerBundle,
} from '@recued/crypto';
import { fsyncDir } from './durable-fs.js';
import {
  IDENTITY_PASSPHRASE_ENV_VAR,
  resolveIdentityKeysPath,
} from './identity/boot.js';
import { createFileServerKeyStore } from './keys/file-store.js';
import { createServerBundleStore } from './server-bundle-store.js';

export const DATABASE_ENROLLMENT_MARKER_SUFFIX = '.database-enrollment-in-progress';

export const resolveDatabaseEnrollmentMarkerPath = (dbPath: string): string =>
  `${resolve(dbPath)}${DATABASE_ENROLLMENT_MARKER_SUFFIX}`;

/** How long a marker keeps authorizing the plaintext -> keyed conversion.
 *
 *  The marker exists to let boot finish a rekey the process died partway
 *  through, and that boot is minutes-to-hours away, not months. Without a bound
 *  a permanently-failed enrollment (persistent BUSY, an OOM, an operator kill)
 *  leaves it on disk forever — and from then on ANY plaintext database found at
 *  that path is silently adopted and encrypted, including one an operator
 *  restored from a pre-encryption filesystem backup. That restore should meet
 *  `D212_DATABASE_PLAINTEXT_REJECTED`, which is the refusal
 *  `pre_launch_no_migration` intends, not a silent conversion. */
const ENROLLMENT_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const databaseEnrollmentInProgress = (
  dbPath: string,
  now: () => number = Date.now,
): boolean => {
  const marker = resolveDatabaseEnrollmentMarkerPath(dbPath);
  let stamped: number;
  try {
    stamped = statSync(marker).mtimeMs;
  } catch {
    return false;
  }
  // An unreadable clock or a marker from the future reads as fresh: refusing to
  // finish a genuinely interrupted rekey is the worse failure of the two.
  const age = now() - stamped;
  return !(age > ENROLLMENT_MARKER_MAX_AGE_MS);
};

/**
 * Persist before creating the dual-wrapped bundle. The marker has no secret
 * material; existence alone authorizes boot to finish a plaintext -> keyed
 * rekey after a crash in the first-enrollment window.
 */
export const beginDatabaseEnrollment = (dbPath: string): void => {
  const marker = resolveDatabaseEnrollmentMarkerPath(dbPath);
  if (existsSync(marker)) return;
  const dir = dirname(marker);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(marker, 'wx', 0o600);
  try {
    const body = Buffer.from('D-212 database enrollment in progress\n', 'utf8');
    let offset = 0;
    while (offset < body.length) {
      const written = writeSync(fd, body, offset, body.length - offset, null);
      if (written === 0) throw new Error(`short write while marking enrollment at ${marker}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Existence is the whole signal, and existence is a directory entry — fsync
  // the file alone and a power loss in the enrollment window can lose the
  // marker, leaving a half-rekeyed realm with nothing telling boot to finish.
  fsyncDir(dir);
};

export const finishDatabaseEnrollment = (dbPath: string): void => {
  try {
    unlinkSync(resolveDatabaseEnrollmentMarkerPath(dbPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
};

export const deriveDatabaseKey = (masterDEK: Uint8Array): Uint8Array =>
  deriveSubDEK(masterDEK, 'database');

export const deriveDatabaseKeyFromRecoveryEntropy = async (
  bundle: ServerBundle,
  recoveryEntropy: Uint8Array,
): Promise<Uint8Array> => {
  const masterDEK = await openServerBundleWithRecoveryEntropy(bundle, recoveryEntropy);
  try {
    return deriveDatabaseKey(masterDEK);
  } finally {
    masterDEK.fill(0);
  }
};

/** Rebind an archive's server wrap to this machine's keyfile before the
 * restored db + sidecar pair is committed. The recovery wrap and Master DEK do
 * not change. If the destination has never enrolled, persist a fresh normal-
 * boot key first; an orphan key is harmless if the later restore swap aborts. */
export const rebindServerBundleForLocalBoot = async (
  dbPath: string,
  bundle: ServerBundle,
  recoveryEntropy: Uint8Array,
  options: { env?: Record<string, string | undefined>; now?: () => number } = {},
): Promise<ServerBundle> => {
  const env = options.env ?? process.env;
  const passphrase = env[IDENTITY_PASSPHRASE_ENV_VAR];
  const keyStore = await createFileServerKeyStore({
    filePath: resolveIdentityKeysPath(dbPath),
    ...(passphrase ? { passphrase } : {}),
  });

  let serverKey = keyStore.loadServerVaultKey();
  const generated = serverKey === null;
  if (!serverKey) serverKey = generateServerKey();
  try {
    // Authenticate recovery + construct the replacement wrap before mutating
    // the keyfile. A wrong recovery factor therefore leaves local state alone.
    const rebound = await rewrapServerBundleForServerKey(
      bundle,
      recoveryEntropy,
      serverKey,
      options.now ? { now: options.now } : {},
    );
    if (generated) {
      keyStore.saveServerVaultKey(serverKey);
      await keyStore.flush?.();
    }
    return rebound;
  } finally {
    serverKey.fill(0);
  }
};

export interface ResolveDatabaseKeyOptions {
  /** Optional pre-storage snapshot; omitting it reads the canonical sidecar. */
  serverBundle?: ServerBundle | null;
  env?: Record<string, string | undefined>;
}

/** Normal boot / local CLI key path: sidecar + keyfile -> Master DEK -> db key. */
export const resolveDatabaseKeyFromServerFiles = async (
  dbPath: string,
  options: ResolveDatabaseKeyOptions = {},
): Promise<Uint8Array | null> => {
  const suppliedBundle = Object.prototype.hasOwnProperty.call(options, 'serverBundle');
  const bundle = suppliedBundle
    ? options.serverBundle ?? null
    : createServerBundleStore(dbPath).load();
  if (!bundle) return null;

  const env = options.env ?? process.env;
  const passphrase = env[IDENTITY_PASSPHRASE_ENV_VAR];
  const keyStore = await createFileServerKeyStore({
    filePath: resolveIdentityKeysPath(dbPath),
    ...(passphrase ? { passphrase } : {}),
  });
  const serverKey = keyStore.loadServerVaultKey();
  if (!serverKey) {
    throw new Error(
      'D212_DATABASE_KEY_UNAVAILABLE: the realm is encrypted but its keyfile has no server vault key; recover with the 24-word recovery key',
    );
  }

  try {
    const masterDEK = await openServerBundleWithServerKey(bundle, serverKey);
    try {
      return deriveDatabaseKey(masterDEK);
    } finally {
      masterDEK.fill(0);
    }
  } catch (err) {
    throw new Error(
      `D212_DATABASE_KEY_UNAVAILABLE: the keyfile cannot open this realm's server bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    serverKey.fill(0);
  }
};
