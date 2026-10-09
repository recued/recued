/** D-212 §7.11 — re-create a realm's keyfile from its recovery key.
 *
 *  The escape hatch §7.2 promises, made reachable. Machine binding is only safe
 *  to adopt because "a wrong provider choice costs a re-pair, never data" — and
 *  until this existed that was not true. `rebindServerBundleForLocalBoot`
 *  constructs the key store FIRST, so an unopenable keyfile threw before any
 *  recovery logic ran: the hatch was bolted shut by the door it exists to
 *  bypass. Measured — normal boot and the recovery rebind failed on the
 *  identical line.
 *
 *  Under §7.10 this path carries more weight than it used to. With the sealing
 *  factor chosen at first boot and permanent thereafter, regeneration is the
 *  ONLY way to change it — so it is not just a disaster path but the answer to
 *  "I moved hosts", "I want to rotate my passphrase", "I am containerising
 *  this". The fresh keyfile takes whatever this host offers now, which is what
 *  makes it the migration route.
 *
 *  ⛔ ORDER IS THE SAFETY PROPERTY, and it goes further than authenticating the
 *  recovery key. `rewrapServerBundleForServerKey` already opens the bundle
 *  before it writes anything, so a wrong mnemonic leaves local state alone. But
 *  bundle-opens proves only that the key matches the BUNDLE — a bundle and a
 *  database can be mismatched (§4's cross-realm class). So the probe here opens
 *  the DATABASE with the derived key before anything is displaced: proof we are
 *  rescuing the realm we think we are, while every artifact is still untouched.
 *
 *  ⛔ EXPLICIT, NEVER AUTOMATIC. "The keychain is locked because nobody has
 *  logged in yet" and "the entry is gone forever" are indistinguishable at the
 *  point of failure, and one is transient. Reaching this from a failed open
 *  would destroy a healthy realm's identity because a user had not logged in —
 *  the same shape as the open-time ladder fallback §7.5 refuses. Hence the
 *  healthy-keyfile guard below: an operator who runs this by mistake is told
 *  no, rather than paying for it.
 */

import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  generateServerKey,
  isValidRecoveryKey,
  openServerBundleWithServerKey,
  recoveryKeyToEntropy,
  rewrapServerBundleForServerKey,
  type ServerBundle,
} from '@recued/crypto';
import { deriveDatabaseKeyFromRecoveryEntropy } from './database-encryption.js';
import { bootServerIdentity, resolveIdentityKeysPath } from './identity/boot.js';
import { CONTAINER_UNSEALED_REFUSAL, readIdentityPassphrase } from './identity/passphrase-env.js';
import { runningInContainer } from './lifecycle/supervisor.js';
import { createFileServerKeyStore } from './keys/file-store.js';
import { recordKeyfileEvent } from './keys/keyfile-event-ledger.js';
import type { KeyfileSealingPosture } from './keys/index.js';
import { openDatabase } from './open-database.js';
import { createServerBundleStore } from './server-bundle-store.js';

export class KeyfileRecoveryError extends Error {
  constructor(readonly code: KeyfileRecoveryFailure, message: string) {
    super(message);
    this.name = 'KeyfileRecoveryError';
  }
}

export type KeyfileRecoveryFailure =
  /** Not a 24-word mnemonic. Checked before the realm, which cannot tell a
   *  typo from a stranger's key and reports both as a mismatch. */
  | 'invalid_recovery_key'
  /** No bundle sidecar — this realm was never encrypted, so there is nothing
   *  for a recovery key to open. Deleting the keyfile is the whole fix. */
  | 'realm_not_encrypted'
  /** The mnemonic does not open this realm's bundle. */
  | 'recovery_key_mismatch'
  /** The bundle opened but its key does not open the database beside it —
   *  a cross-realm pairing. Refusing is the point: regenerating here would
   *  bind a keyfile to a database it cannot read. */
  | 'bundle_database_mismatch'
  /** The existing keyfile opens fine, so there is nothing to recover and
   *  regenerating would destroy a working identity for no reason. */
  | 'keyfile_is_healthy';

export interface KeyfileRecoveryResult {
  keyfilePath: string;
  /** Where the unopenable keyfile was moved, or null when none existed. Kept
   *  rather than deleted: it is the only copy of an identity we are about to
   *  replace, and a displaced file costs nothing. */
  displacedTo: string | null;
  /** How the FRESH keyfile is sealed — chosen now, from this host, which is
   *  what makes regeneration the supported way to change the factor. */
  posture: KeyfileSealingPosture;
  /** Fingerprint of the new server identity. Different from the old one by
   *  construction; surfaced so the operator can recognise the re-pair. */
  serverIdentityFingerprint: string;
  /** Whether the change reached `keyfile-events.log` — the record the next boot
   *  turns into an audit row. Reported rather than assumed: recording is
   *  best-effort, and a caller printing "this is recorded" without checking
   *  would be claiming something it never verified. */
  eventRecorded: boolean;
}

/** True when the keyfile at `path` already serves THIS realm — i.e. when boot
 *  would succeed as things stand. Used only to refuse a needless regeneration;
 *  never to decide whether to proceed automatically.
 *
 *  ⛔ "The file decodes" is NOT the question. It was, and that made this guard
 *  refuse exactly the situations it exists to rescue: the keyfile is readable
 *  but its key does not open this realm's bundle. Three ways to land there, all
 *  reproduced —
 *
 *    - a crash (or a bundle-write failure) between the two writes at the bottom
 *      of this file, which leaves a fresh, perfectly decodable keyfile holding a
 *      key the unchanged bundle has never heard of. The comment there promises
 *      the next run "overwrites harmlessly"; the decode-only guard is what made
 *      that false;
 *    - a keyfile restored from the wrong backup, or copied off another host;
 *    - two realm dbs in ONE directory. The bundle sidecar is per-DB by suffix,
 *      deliberately, but the keyfile is per-DIRECTORY — so the second realm's
 *      boot reads a valid keyfile that belongs to the first.
 *
 *  Boot's real check is `resolveDatabaseKeyFromServerFiles`: load the key, open
 *  this realm's bundle with it, throw `D212_DATABASE_KEY_UNAVAILABLE` if it does
 *  not. Ask the same question here, so "there is nothing to recover" is a claim
 *  about the realm and not about a file's syntax. */
const keyfileServesRealm = async (
  path: string,
  bundle: ServerBundle,
  env: NodeJS.ProcessEnv,
): Promise<boolean> => {
  if (!existsSync(path)) return false;
  const passphrase = readIdentityPassphrase(env);
  let keyStore: Awaited<ReturnType<typeof createFileServerKeyStore>>;
  try {
    keyStore = await createFileServerKeyStore({
      filePath: path,
      ...(passphrase ? { passphrase } : {}),
      // Never provision while merely probing: this must not write to the
      // operator's keychain to answer a question about an existing file.
      warn: () => {},
    });
  } catch {
    return false; // unopenable — the original disaster case
  }
  const serverKey = keyStore.loadServerVaultKey();
  if (!serverKey) return false;
  try {
    // The same unwrap boot performs. Opening proves the pairing, so the Master
    // DEK is discarded immediately — this is a question, not a key resolution.
    (await openServerBundleWithServerKey(bundle, serverKey)).fill(0);
    return true;
  } catch {
    return false; // decodable, but not THIS realm's key
  } finally {
    serverKey.fill(0);
  }
};

/** Re-create the keyfile for the realm at `dbPath` from `recoveryKey`.
 *
 *  ⚠ This RESCUES THE REALM AND DESTROYS THE IDENTITY. The keyfile is not only
 *  the server vault key: it also holds `server_identity`, `publisher_identity`
 *  and the D-175 account binding. Every paired client must re-pair, the
 *  publisher identity changes, and the account binding is gone. §7.2's "costs a
 *  re-pair, never data" is accurate but reads cheaper than it is — callers are
 *  expected to say the parts out loud before invoking. */
export const regenerateKeyfileFromRecoveryKey = async (args: {
  dbPath: string;
  recoveryKey: string;
  env?: NodeJS.ProcessEnv;
  /** Seal the FRESH keyfile against a platform store when no passphrase is
   *  set. Matches the server's own composition root; off for tooling. */
  machineSealing?: boolean;
  /** Injectable for tests; production stamps with the wall clock. */
  now?: () => number;
  /** Override Argon2id KEK parameters for the FRESH keyfile. Tests pass weaker
   *  params for speed — two OWASP-cost derivations (seal, then reopen) run ~5s,
   *  which is the default test timeout. Production callers leave this unset.
   *  The read side needs no counterpart: the parameters used at write time are
   *  persisted in the file, so reopening self-configures. */
  argon2_params?: { t: number; m: number; p: number };
}): Promise<KeyfileRecoveryResult> => {
  const { dbPath, recoveryKey } = args;
  const env = args.env ?? process.env;
  const keyfilePath = resolveIdentityKeysPath(dbPath);
  // Resolved the same way `resolveIdentityKeysPath` does, so the event ledger
  // lands in the directory that actually holds the keyfile rather than wherever
  // a relative `--db` was typed from.
  const dataPath = dirname(resolve(dbPath));

  // ── 0. The mnemonic parses ────────────────────────────────────────────
  // Ahead of the realm checks, which collapse a malformed key to "mismatch"
  // and would tell someone who mistyped a word that they have the wrong realm.
  if (!isValidRecoveryKey(recoveryKey)) {
    throw new KeyfileRecoveryError(
      'invalid_recovery_key',
      'That is not a valid 24-word recovery phrase.',
    );
  }

  // ── 1. There is something to recover ──────────────────────────────────
  const bundleStore = createServerBundleStore(dbPath);
  const bundle = bundleStore.load();
  if (!bundle) {
    throw new KeyfileRecoveryError(
      'realm_not_encrypted',
      `No server vault bundle beside ${dbPath}, so this realm is not encrypted and a recovery key cannot open anything. `
      + 'If the keyfile is unopenable, delete it and restart — a fresh identity is the whole cost.',
    );
  }

  // ── 2. …and it is not already working ─────────────────────────────────
  // The guard against an operator running this on a healthy realm. Regenerating
  // would cost them every client pairing to fix a problem they do not have.
  // "Working" means it opens THIS realm's bundle — see `keyfileServesRealm`.
  if (await keyfileServesRealm(keyfilePath, bundle, env)) {
    throw new KeyfileRecoveryError(
      'keyfile_is_healthy',
      `${keyfilePath} already opens this realm's vault bundle, so there is nothing to recover. `
      + 'Regenerating would replace a working server identity and force every paired client to pair again. '
      + 'If you meant to change how the keyfile is sealed, move it aside deliberately first.',
    );
  }

  // ── 3. PROBE, while everything is still untouched ─────────────────────
  const entropy = recoveryKeyToEntropy(recoveryKey);
  let databaseKey: Uint8Array;
  try {
    databaseKey = await deriveDatabaseKeyFromRecoveryEntropy(bundle, entropy);
  } catch (err) {
    entropy.fill(0);
    throw new KeyfileRecoveryError(
      'recovery_key_mismatch',
      `That recovery key does not open this realm's vault bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ⛔ The bundle opening is NOT enough. It proves the mnemonic matches the
  // bundle; it does not prove the bundle belongs to the database beside it.
  // Open the db for real before anything is displaced.
  try {
    const probe = await openDatabase(dbPath, { databaseKey, readonly: true });
    probe.close();
  } catch (err) {
    throw new KeyfileRecoveryError(
      'bundle_database_mismatch',
      `The recovery key opened the vault bundle, but its key does not open ${dbPath}. `
      + 'The bundle and the database are from different realms; regenerating would bind a keyfile to a database it cannot read. '
      + `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    databaseKey.fill(0);
  }

  // ── 4. Only now mutate ────────────────────────────────────────────────
  // Displace rather than delete. It is the only copy of the identity being
  // replaced, and keeping it costs a file.
  let displacedTo: string | null = null;
  if (existsSync(keyfilePath)) {
    displacedTo = `${keyfilePath}.unopenable-${(args.now ?? Date.now)()}`;
    renameSync(keyfilePath, displacedTo);
  }

  try {
    // A fresh keyfile, sealed by whatever this host offers NOW — which is what
    // makes regeneration the supported way to change the sealing factor.
    const booted = await bootServerIdentity({
      dbPath,
      machineSealing: args.machineSealing ?? false,
      // Inside a container a regenerated keyfile is as unsealable as a first
      // boot's, and refused the same way; the catch below puts the old one back.
      ...(runningInContainer(env) ? { refuseUnsealed: CONTAINER_UNSEALED_REFUSAL } : {}),
      env,
      ...(args.argon2_params ? { argon2_params: args.argon2_params } : {}),
    });
    const serverKey = generateServerKey();
    try {
      // Rewrap before persisting either half: `rewrapServerBundleForServerKey`
      // re-authenticates the recovery factor, so a failure here leaves the
      // displaced keyfile as the only artifact touched and it can be restored.
      const rebound = await rewrapServerBundleForServerKey(
        bundle,
        entropy,
        serverKey,
        args.now ? { now: args.now } : {},
      );
      // Keyfile first + flush, then the bundle — the same crash ordering
      // enrollment uses. A crash between them leaves a keyfile whose key no
      // bundle references, which the next run of this command overwrites
      // harmlessly; the inverse could leave a bundle nothing can open.
      booted.keyStore.saveServerVaultKey(serverKey);
      await booted.keyStore.flush?.();
      bundleStore.save(rebound);
    } finally {
      serverKey.fill(0);
    }

    const posture = booted.keyStore.sealingPosture?.() ?? 'none';
    const fingerprint = booted.identity.serverIdentityKey().public_key_fingerprint;

    // ⛔ After `bundleStore.save`, which is the last statement that can fail —
    // reaching the catch below means the rollback puts the OLD keyfile back, and
    // an entry written before this point would claim a regeneration that was
    // undone. This is also the only durable record that the IDENTITY changed:
    // the server is stopped, so nothing can audit it as it happens, and the
    // fingerprint here is the new one every paired device is about to reject.
    //
    // `posture` matters most on this path. Regeneration takes whatever the host
    // offers NOW, so an operator who ran this without a passphrase on a host
    // with no secret store has an UNSEALED realm — the CLI says so once, and
    // this is what still says so a month later.
    const recorded = recordKeyfileEvent(dataPath, {
      kind: 'keyfile_regenerated',
      at: (args.now ?? Date.now)(),
      keyfile_path: keyfilePath,
      posture,
      ...(displacedTo ? { previous_keyfile: displacedTo } : {}),
      server_identity_fingerprint: fingerprint,
    });

    return {
      keyfilePath,
      displacedTo,
      posture,
      serverIdentityFingerprint: fingerprint,
      eventRecorded: recorded !== null,
    };
  } catch (err) {
    // Put the operator back where they started. They are already in a recovery
    // situation; leaving them with neither the old keyfile nor a new one would
    // be strictly worse than the state they arrived in.
    //
    // ⛔ Including when a FRESH keyfile is already sitting there. Reaching this
    // catch means `bundleStore.save` did not run — it is the last statement of
    // the try — so the bundle is still the one the OLD keyfile was made for,
    // and the fresh key opens nothing. Skipping the rollback because the path
    // was occupied left that worthless file in place as the realm's identity.
    if (displacedTo) {
      try {
        if (existsSync(keyfilePath)) unlinkSync(keyfilePath);
        renameSync(displacedTo, keyfilePath);
      } catch { /* best effort — the displaced copy survives under its own name */ }
    }
    throw err;
  } finally {
    entropy.fill(0);
  }
};
