/** D-212 — rotate the passphrase that seals the keyfile, keeping the realm.
 *
 *  ── Why this exists ─────────────────────────────────────────────────
 *  §7.10 makes the sealing FACTOR permanent for a realm, and §7.11's
 *  regeneration was the only way to change anything about it — at the cost of
 *  a new server identity, so every device re-pairs, the publisher identity
 *  changes and the account binding is lost. That is the right price for
 *  "I lost the passphrase". It is an absurd price for "I want a new one".
 *
 *  This is the cheap half, and it is cheap for a structural reason: the
 *  passphrase wraps the FILE, while the realm's bundle is wrapped to the
 *  server KEY inside it (`wrapped_server`). Re-encoding the payload under a
 *  new passphrase leaves the server key, the Master DEK, the database and
 *  every identity untouched. Nothing re-pairs.
 *
 *  ── Who may do it ───────────────────────────────────────────────────
 *  The current passphrase, and nothing else. That is not a relaxation — it is
 *  what the operation cryptographically needs, and adding the recovery key on
 *  top would buy nothing:
 *
 *   · Anyone holding the current passphrase and the file already owns the
 *     realm — keyfile → server key → `wrapped_server` → Master DEK → the
 *     database. A gate they can already pass protects nothing.
 *   · The lockout it appears to prevent stays reachable with `rm`. A control
 *     that blocks one route to an outcome available by simpler means is
 *     assurance-shaped, not assurance.
 *   · And it would cost something real: making the 24-word key part of
 *     ROUTINE maintenance trains operators to fetch it out of offline
 *     storage, or keep it on the machine. The passphrase opens this host's
 *     keyfile; the recovery key opens `wrapped_rec` in EVERY archive of the
 *     realm, including offsite ones. Bringing it online to change a
 *     passphrase widens the blast radius of the exact compromise it was
 *     meant to insure against.
 *
 *  So each path asks for exactly what it needs: this one the current
 *  passphrase, §7.11's regeneration the recovery key (which is not a policy
 *  gate either — it is the only way to reach the Master DEK through
 *  `wrapped_rec` once the keyfile is unreadable), and neither credential
 *  means nothing can be opened and nothing can be rotated.
 *
 *  ── CLI only ────────────────────────────────────────────────────────
 *  The new passphrase has to reach the service environment or the next boot
 *  fails, and no rpc can edit a systemd unit. §7.5 / §7.10 also forbid an
 *  env-var difference from re-wrapping anything by itself: a passphrase that
 *  appears for one accidental run must never silently re-seal a live realm.
 *  Deliberate, explicit, at a terminal — the same discipline as
 *  `recover-keyfile`. */

import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { createServerBundleStore } from './server-bundle-store.js';
import { createInstanceLock } from './lifecycle/instance-lock.js';
import { resolveIdentityKeysPath } from './identity/boot.js';
import {
  createFileServerKeyStore,
  resealKeyfileWithPassphrase,
} from './keys/file-store.js';
import {
  DirectoryReservationHeldError,
  withDirectoryReservation,
} from './keys/directory-reservation.js';
import { recordKeyfileEvent } from './keys/keyfile-event-ledger.js';
import { openServerBundleWithServerKey } from '@recued/crypto';

/** Mirrors `archive-restore.ts` — the lock file a running server holds. */
const SERVER_LOCK_FILE = 'recued-server.lock';

export type PassphraseRotationFailure =
  /** A live server holds a key store built with the OLD passphrase. Any
   *  identity or account-binding write it makes re-persists the file under
   *  that passphrase and silently undoes the rotation. */
  | 'server_running'
  /** Nothing to rotate. */
  | 'no_keyfile'
  /** The file is unsealed or machine-sealed. Changing the factor CLASS is
   *  §7.11's regeneration, not this. */
  | 'not_passphrase_sealed'
  /** The current passphrase does not open the file. */
  | 'current_passphrase_wrong'
  /** Empty, or identical to the current one. */
  | 'new_passphrase_invalid'
  /** The keyfile opens but its server key does not open this realm's bundle,
   *  so re-sealing would preserve a broken pair and call it success. */
  | 'keyfile_not_for_this_realm'
  /** The re-sealed file did not open with the new passphrase. The original
   *  is restored; the realm is exactly as it was. */
  | 'verify_failed';

export class PassphraseRotationError extends Error {
  constructor(readonly code: PassphraseRotationFailure, message: string) {
    super(message);
    this.name = 'PassphraseRotationError';
  }
}

export interface PassphraseRotationResult {
  keyfilePath: string;
  /** The pre-rotation copy, kept rather than deleted. Its `.pre-rotate-<ms>`
   *  name is also the durable record that a rotation happened here and when —
   *  the server is stopped, so there is no audit log to write to. */
  backupPath: string;
  /** UNCHANGED by construction. Returned so the operator can see for
   *  themselves that the identity survived, rather than being told. */
  serverIdentityFingerprint: string;
  /** Whether the change reached `keyfile-events.log` — the record the next boot
   *  turns into an audit row.
   *
   *  ⚠ Reported rather than assumed. Recording is best-effort (a rotation that
   *  succeeded must not be reported as failed because a log line would not
   *  write), so a caller that prints "this is recorded" without checking would
   *  be making a claim it has not verified — about the one artifact an operator
   *  would later go looking for. */
  eventRecorded: boolean;
}

const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Does this keyfile's server key open that bundle? */
const servesRealm = async (
  keyfilePath: string,
  passphrase: string,
  bundle: ReturnType<ReturnType<typeof createServerBundleStore>['load']>,
): Promise<boolean> => {
  if (!bundle) return true; // realm not encrypted yet — nothing to disagree with
  const store = await createFileServerKeyStore({
    filePath: keyfilePath,
    passphrase,
    // Never provision while merely probing: this must not write to the
    // operator's keychain to answer a question about an existing file.
    warn: () => {},
  });
  const serverKey = store.loadServerVaultKey();
  if (!serverKey) return false;
  try {
    (await openServerBundleWithServerKey(bundle, serverKey)).fill(0);
    return true;
  } catch {
    return false;
  } finally {
    serverKey.fill(0);
  }
};

/** Re-seal this realm's keyfile under `newPassphrase`.
 *
 *  Probe-before-mutate throughout, the discipline §7.11 established: every
 *  refusal below fires while the keyfile on disk is still untouched. */
export const rotateKeyfilePassphrase = async (args: {
  dbPath: string;
  currentPassphrase: string;
  newPassphrase: string;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  /** Weaker Argon2id cost for tests; production leaves it unset. */
  argon2_params?: { t: number; m: number; p: number };
  /** The post-write check, injectable ONLY so its failure branch is
   *  reachable. Defaults to the real reopen.
   *
   *  ⚠ A seam for a test is usually a smell, but the alternative here is
   *  leaving the ROLLBACK untested — and the rollback is the reason a failed
   *  rotation does not lock the operator out. Nothing organic can make a
   *  freshly-sealed keyfile fail to reopen: the cross-realm case is refused
   *  before the write, and everything else is a crypto or IO anomaly. */
  verifyOpens?: (keyfilePath: string, passphrase: string) => Promise<boolean>;
}): Promise<PassphraseRotationResult> => {
  const dbPath = resolve(args.dbPath);
  const keyfilePath = resolveIdentityKeysPath(dbPath);
  const dataPath = dirname(dbPath);
  const isProcessAlive = args.isProcessAlive ?? defaultIsProcessAlive;

  // ── 1. A running server would undo this ──────────────────────────────
  // Not a courtesy check. The live process holds a store constructed with the
  // OLD passphrase, and `persist()` always encodes with the passphrase it was
  // built with — so a publisher-identity or account-binding write after this
  // rotation silently rewrites the file under the old one. The operator would
  // then have a new passphrase that stops working at some unpredictable later
  // boot, which is a worse failure than refusing here.
  const lock = createInstanceLock({ lockPath: join(dataPath, SERVER_LOCK_FILE) });
  // Asked twice — before the probes and again at the act site. The two say
  // different things on purpose: one is "you knew this already", the other is
  // "something changed under you", and an operator who sees the second learns
  // that a start raced their rotation rather than that they forgot to stop it.
  const refuseIfServerRunning = (phase: 'before' | 'during'): void => {
    const holder = lock.inspect();
    if (!holder || !isProcessAlive(holder.pid)) return;
    throw new PassphraseRotationError(
      'server_running',
      phase === 'before'
        ? `The server is running (pid ${holder.pid}). Stop it before rotating: a live server holds `
          + 'the old passphrase in memory and would rewrite the keyfile under it.'
        : `A server started (pid ${holder.pid}) while this rotation was preparing, and it holds the `
          + 'OLD passphrase in memory. Nothing was changed — stop it and run this again.',
    );
  };
  refuseIfServerRunning('before');

  // ── 2. There is something to rotate, and it is a passphrase ──────────
  if (!existsSync(keyfilePath)) {
    throw new PassphraseRotationError(
      'no_keyfile',
      `No keyfile at ${keyfilePath}, so there is no passphrase to change. `
        + 'Start the server once to create one.',
    );
  }

  const newPassphrase = args.newPassphrase;
  if (newPassphrase.length === 0) {
    throw new PassphraseRotationError('new_passphrase_invalid', 'The new passphrase is empty.');
  }
  if (newPassphrase === args.currentPassphrase) {
    // Refuse rather than report success for a no-op: an operator who mistyped
    // the same value twice should learn that nothing changed.
    throw new PassphraseRotationError(
      'new_passphrase_invalid',
      'The new passphrase is identical to the current one — nothing was changed.',
    );
  }

  const bundle = createServerBundleStore(dbPath).load();

  // ⛔ Decide the FACTOR from the file itself, before opening it.
  //
  // The first version inferred this from how the open behaved, and that does
  // not work in the direction that matters: a machine-sealed keyfile opens
  // through its RECORDED PROVIDER and ignores the supplied passphrase
  // entirely, so the probe succeeded for any string at all — and the reseal
  // below would then have re-encoded it under that string, silently
  // converting a machine-sealed realm to passphrase sealing with a
  // credential nobody chose. The refusal was documented in the message and
  // never enforced by the code.
  //
  // The header says which factor sealed it. Read it.
  let doc: { encrypted?: unknown; sealed_by?: unknown };
  try {
    doc = JSON.parse(readFileSync(keyfilePath, 'utf-8')) as typeof doc;
  } catch (err) {
    throw new PassphraseRotationError(
      'not_passphrase_sealed',
      `Cannot read ${keyfilePath} to determine how it is sealed: `
        + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc.encrypted !== true || typeof doc.sealed_by === 'string') {
    throw new PassphraseRotationError(
      'not_passphrase_sealed',
      `${keyfilePath} is sealed by ${typeof doc.sealed_by === 'string'
        ? `'${doc.sealed_by}' (a platform secret store)`
        : 'nothing'}, not by a passphrase, so there is none to rotate. `
        + 'Changing how a keyfile is sealed is a factor change, which regeneration owns: '
        + "set RECUED_IDENTITY_PASSPHRASE and run 'recued recover-keyfile'.",
    );
  }

  // Open with the CURRENT factor — now known to be a passphrase, so a wrong
  // one genuinely fails rather than being ignored.
  let opened = false;
  try {
    opened = await servesRealm(keyfilePath, args.currentPassphrase, bundle);
  } catch {
    throw new PassphraseRotationError(
      'current_passphrase_wrong',
      `That passphrase does not open ${keyfilePath}. Nothing was changed. `
        + "If the current passphrase is lost, 'recued recover-keyfile' rebuilds the keyfile "
        + 'from your 24-word recovery key — at the cost of the server identity.',
    );
  }
  if (!opened) {
    throw new PassphraseRotationError(
      'keyfile_not_for_this_realm',
      `${keyfilePath} opens, but the server key inside it does not open the vault bundle beside `
        + `${dbPath}. Re-sealing it would preserve a mismatched pair. Use `
        + "'recued recover-keyfile' with your recovery key to rebuild the keyfile for THIS realm.",
    );
  }

  // ── 3. Only now mutate. Copy first: the original must survive a crash
  //       between the write and the verify. ─────────────────────────────
  const stamp = (args.now ?? Date.now)();
  const backupPath = `${keyfilePath}.pre-rotate-${stamp}`;

  // Cross-process reservation over the same directory-scoped keyfile the
  // enrollment door reserves. The running-server guard above stops the common
  // collision, but two CLI invocations answer to no lock at all — and both
  // write this one file.
  return withDirectoryReservation(dataPath, async () => {
  // ⛔ Ask again, holding the reservation. The check at step 1 ran before an
  // Argon2id derivation and a bundle open — hundreds of milliseconds in which a
  // server can start, claim the instance lock, and build a key store from the
  // OLD passphrase. It is the only window left: the server claims that lock
  // BEFORE it opens the keyfile, so a holder here means a process that either
  // has read the file or is about to. Asking earlier says where things stood;
  // asking here says where they stand.
  //
  // ⚠ This narrows the race, it does not own the outcome. A server that got its
  // read in a moment before this line still exists, and what stops IT from
  // undoing the rotation is the act-site guard in `createFileServerKeyStore`'s
  // `persist()`, which refuses to overwrite a keyfile it no longer recognises.
  refuseIfServerRunning('during');
  copyFileSync(keyfilePath, backupPath);

  try {
    await resealKeyfileWithPassphrase({
      filePath: keyfilePath,
      currentPassphrase: args.currentPassphrase,
      newPassphrase,
      ...(args.argon2_params ? { argon2_params: args.argon2_params } : {}),
    });

    // ── 4. Verify the artifact that landed, the way the consumer will ──
    // Not "did the write succeed" — open the new file with the new passphrase
    // and confirm its server key still opens this realm. A rotation that
    // reports success while leaving an unopenable keyfile is exactly the
    // failure this whole path exists to avoid, and it would surface at the
    // next boot with the operator's only other route being the recovery key.
    const verify = args.verifyOpens
      ?? ((path: string, passphrase: string) => servesRealm(path, passphrase, bundle));
    if (!(await verify(keyfilePath, newPassphrase))) {
      throw new PassphraseRotationError(
        'verify_failed',
        'The re-sealed keyfile did not open with the new passphrase.',
      );
    }
  } catch (err) {
    // Put the operator back exactly where they started. The backup is the
    // known-good file; restoring it is always correct here, because reaching
    // this catch means the new one is either absent or unverified.
    try {
      if (existsSync(keyfilePath)) unlinkSync(keyfilePath);
      renameSync(backupPath, keyfilePath);
    } catch { /* the .pre-rotate- copy survives under its own name */ }
    if (err instanceof PassphraseRotationError) throw err;
    throw new PassphraseRotationError(
      'verify_failed',
      `Re-sealing failed and the original keyfile was restored: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const store = await createFileServerKeyStore({
    filePath: keyfilePath,
    passphrase: newPassphrase,
    warn: () => {},
  });
  const identity = store.loadServerIdentityKey();

  // ⛔ Recorded only HERE — after the reseal, after the verify, after the
  // reopen. Everything above this line either refuses without touching the
  // keyfile or restores the backup, and an entry written any earlier would
  // outlive a rollback and become the false claim the record exists to avoid.
  //
  // The server is stopped, so there is no audit log to write to; the next boot
  // mirrors this line into one. Best-effort by construction — a rotation that
  // succeeded must never be reported as failed because a log line would not
  // write, so `recordKeyfileEvent` warns and returns null rather than throwing.
  const recorded = recordKeyfileEvent(dataPath, {
    kind: 'passphrase_rotated',
    at: stamp,
    keyfile_path: keyfilePath,
    // A rotation cannot change the factor CLASS — the header check above
    // refuses anything not already passphrase-sealed — so this is the one
    // posture reachable here, and it is stated rather than inferred at replay.
    posture: 'passphrase',
    previous_keyfile: backupPath,
    ...(identity ? { server_identity_fingerprint: identity.public_key_fingerprint } : {}),
  });

  return {
    keyfilePath,
    backupPath,
    serverIdentityFingerprint: identity?.public_key_fingerprint ?? 'unknown',
    eventRecorded: recorded !== null,
  };
  }).catch((err: unknown) => {
    // Report a held reservation in this command's own vocabulary rather than
    // leaking the primitive's error class to the CLI.
    if (err instanceof DirectoryReservationHeldError) {
      throw new PassphraseRotationError('server_running', err.message);
    }
    throw err;
  });
};
