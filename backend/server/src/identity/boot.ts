/** D-148 follow-up #6 — server-identity boot wiring.
 *
 *  Composes the disk-backed `ServerKeyStore` + the identity manager
 *  into a single `bootServerIdentity` helper bin.ts can call once at
 *  startup. The keys file lives alongside the server db so a self-
 *  host operator's "backup the db directory" routine captures the
 *  signing identity automatically.
 *
 *  Why a helper rather than inline wiring. The composition reads as
 *  a unit (path resolve → store load/create → identity construct →
 *  durability fence), and keeping it together lets the wiring test
 *  exercise the same code bin.ts runs at boot. The signing-audit
 *  wrapper itself (`createSigningAuditLog`) stays at the caller —
 *  bin.ts already holds the underlying `AuditLogStore` reference
 *  and wrapping is a one-liner.
 *
 *  Durability fence. The file-backed store's `save*` calls schedule
 *  an async persist (fsync + atomic rename). First boot generates
 *  both keypairs and schedules two persists; without an explicit
 *  flush, a crash before disk-sync would leave the next boot
 *  generating a fresh identity, orphaning any high-assurance row
 *  signed by the original. The `await keyStore.flush?.()` pin
 *  closes the gap. Subsequent boots load from disk so `ensure*`
 *  doesn't schedule a persist and the flush is a no-op.
 *
 *  Passphrase. Optional. When `RECUED_IDENTITY_PASSPHRASE` is set
 *  the keys file is AEAD-sealed under an Argon2id-derived KEK. When
 *  unset, the file holds cleartext key bytes. The live database is encrypted
 *  as of D-212 slice 3, but this same keyfile carries the normal-boot unwrap
 *  key; disk access to both files can therefore still open the realm. Setting
 *  the passphrase raises that physical-access boundary, while the recovery key
 *  remains the keyfile-loss path.
 */

import { dirname, join, resolve } from 'node:path';
import {
  createFileServerKeyStore,
  type CreateFileServerKeyStoreOptions,
} from '../keys/file-store.js';
import type { ServerKeyStore } from '../keys/index.js';
import { createServerIdentity, type ServerIdentity } from './index.js';
import { IDENTITY_PASSPHRASE_ENV_VAR, readIdentityPassphrase } from './passphrase-env.js';

/** Filename used for the server-identity keys file. Resolved
 *  relative to `dirname(dbPath)` so backups that capture the db
 *  directory also capture the identity. */
export const IDENTITY_KEYS_FILENAME = 'recued-server-identity.json';

/** Env-var name the boot path reads for the optional file passphrase. It lives
 *  in a leaf (`passphrase-env.ts`) so code keeping it away from child processes
 *  can name it without loading the key store; re-exported here unchanged. */
export { IDENTITY_PASSPHRASE_ENV_VAR };

/** Resolve the absolute identity-keys file path from a server db
 *  path. Pulled out as a named helper so the wiring test can assert
 *  the path is co-located with the db. */
export const resolveIdentityKeysPath = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), IDENTITY_KEYS_FILENAME);

export interface BootServerIdentityOptions {
  /** Absolute or relative server db path. The identity keys file is
   *  resolved next to it via `resolveIdentityKeysPath`. */
  dbPath: string;
  /** Seal a NEW keyfile against a platform secret store when no passphrase is
   *  set. Off by default — provisioning writes to the operator's OS keychain,
   *  which tooling and tests must not do on their behalf. The server's
   *  composition root turns it on. */
  machineSealing?: boolean;
  /** With `machineSealing`: refuse, with this message, to create a NEW keyfile
   *  unsealed. The server sets it inside a container. */
  refuseUnsealed?: string;
  /** Override the passphrase. Tests pass `null` to force cleartext
   *  regardless of the live process env. Default: read from `env`. */
  passphrase?: string | null;
  /** Optional override of `process.env` for the passphrase lookup.
   *  Tests pass a stub env; production callers leave undefined. */
  env?: NodeJS.ProcessEnv;
  /** Optional override of Argon2id KEK params. Tests pass weaker
   *  params for speed; production callers leave unset to use the
   *  file-store default. */
  argon2_params?: CreateFileServerKeyStoreOptions['argon2_params'];
}

export interface BootedServerIdentity {
  identity: ServerIdentity;
  keyStore: ServerKeyStore;
  /** Resolved absolute path of the keys file. Surfaced for boot logs
   *  + diagnostic surfaces (Settings → Server → Identity card). */
  filePath: string;
  /** True iff the boot generated at least one fresh keypair (first
   *  boot or wiped keys file). Callers can emit a one-time audit row
   *  + log line on `created: true`. */
  created: boolean;
}

/** Build the disk-backed `ServerKeyStore` + initialise the identity
 *  manager. Idempotent — re-running on an existing keys file loads
 *  the persisted keys; running on a missing file generates both,
 *  flushes them to disk, and returns `created: true`.
 *
 *  Throws if the on-disk file is corrupt or fails decrypt under the
 *  supplied passphrase. The caller (bin.ts) is expected to surface
 *  that to the operator rather than overwrite. */
export const bootServerIdentity = async (
  options: BootServerIdentityOptions,
): Promise<BootedServerIdentity> => {
  const filePath = resolveIdentityKeysPath(options.dbPath);
  const env = options.env ?? process.env;
  // Explicit `null` opts out of the env lookup entirely (tests).
  // `undefined` (the default) falls back to the env var.
  const passphrase =
    options.passphrase === null
      ? undefined
      : options.passphrase ?? readIdentityPassphrase(env);
  const keyStore = await createFileServerKeyStore({
    filePath,
    ...(passphrase ? { passphrase } : {}),
    ...(options.argon2_params ? { argon2_params: options.argon2_params } : {}),
    ...(options.refuseUnsealed !== undefined ? { refuseUnsealed: options.refuseUnsealed } : {}),
    // D-212 slice 5 — off unless the caller asks. `bootServerIdentity` is
    // reached by tooling and by 15 test call sites as well as by the server, and
    // provisioning writes to the operator's OS keychain; that is a decision for
    // the composition root, not a default for everyone who boots an identity.
    // `compose-storage-context` turns it on for the real server.
    machineSealing: options.machineSealing ?? false,
  });
  // Track whether `ensureServerIdentityKeys` had to generate fresh
  // keys. The store load happens synchronously; a null on either
  // class means `createServerIdentity` will mint + save.
  const created =
    keyStore.loadServerIdentityKey() === null ||
    keyStore.loadPublisherIdentityKey() === null;
  const identity = createServerIdentity({ store: keyStore });
  // Durability fence — first-boot keys must hit disk before any
  // high-assurance audit row signs against them. No-op on reload.
  if (created && keyStore.flush) await keyStore.flush();
  return { identity, keyStore, filePath, created };
};
