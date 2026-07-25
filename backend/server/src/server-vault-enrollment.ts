/** Server vault enrollment + boot auto-unlock orchestration (slice 3).
 *
 *  Three helpers that couple the KeyManager to the keyfile-held server
 *  key. They are the CALLERS of the slice-2 mechanism:
 *
 *    - `enrollRealmRecoveryKey` — the DOOR. The one sequence every
 *      user-facing enrollment path runs: verify against the realm
 *      sentinel, turn encryption on, then enroll-or-verify the sentinel.
 *      Both doors (`/auth/pair` HTTP and the `pair.registerRecoveryKey`
 *      WS twin) go through it, so neither can drift from the other.
 *
 *    - `enrollServerVaultFromRecoveryKey` — the mechanism the door drives.
 *      Mints a server key, persists it in the keyfile, and initializes
 *      the vault bundle so the Master DEK is dual-wrapped (server key +
 *      recovery key). Encryption turns on here and nowhere else.
 *
 *    - `autoUnlockServerVaultFromKeyfile` — the RUNNING path. Runs once
 *      at boot: reads the server key from the keyfile and unlocks the
 *      Master DEK, so a headless server decrypts its own warehouse with
 *      no human present. The recovery key is NOT involved on this path —
 *      it is a connection credential + disaster-recovery anchor only.
 *
 *  ⚠ The door is the unit to reuse, not the mechanism. This comment used
 *  to claim the WS twin ran the mechanism; it never did — it wrote the
 *  sentinel alone, opening the enrollment gate over a plaintext database.
 *  A twin that hand-rolls its own sequence is how that happened, so both
 *  doors now call `enrollRealmRecoveryKey` and nothing else.
 *
 *  Crash-safety ordering (enroll): the server key is written to the
 *  keyfile AND FLUSHED before the bundle is created. A crash between the
 *  two leaves an orphan key in the keyfile but NO bundle — the next
 *  attempt sees `state === 'uninitialized'` and harmlessly regenerates,
 *  overwriting the orphan. The inverse order (bundle first) could leave a
 *  bundle the keyfile can't open — a headless lock-out recoverable only
 *  via the recovery key — so we avoid it.
 *
 *  Single-flight: enforced, not assumed. `enrollRealmRecoveryKey`
 *  serializes on a per-database promise chain, because the mechanism
 *  below yields twice (keyfile flush, bundle creation) and the
 *  KeyManager's orphan guard checks-then-acts across its own await — two
 *  concurrent first-pairs with DIFFERENT recovery keys could otherwise
 *  split the keyfile, bundle, database and sentinel across both.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  generateServerKey,
  isValidRecoveryKey,
  serverBundleFromJSON,
} from '@recued/crypto';
import {
  SERVER_BUNDLE_SIDECAR_SUFFIX,
  resolveServerBundlePath,
} from './server-bundle-store.js';
import {
  DirectoryReservationHeldError,
  withDirectoryReservation,
} from './keys/directory-reservation.js';
import type Database from 'better-sqlite3';
import {
  beginDatabaseEnrollment,
  databaseEnrollmentInProgress,
  finishDatabaseEnrollment,
} from './database-encryption.js';
import type { KeyManager } from './key-manager.js';
import type { ServerKeyStore } from './keys/index.js';
import { rekeyDatabase } from './open-database.js';
import type { RecoveryKeyCheckStore } from './recovery-key-store.js';

export type ServerVaultEnrollResult = 'enrolled' | 'already_enrolled';
export type ServerVaultUnlockResult = 'unlocked' | 'skipped';

/** The sibling realm this enrollment would lock out, or null.
 *
 *  ⛔ The keyfile is DIRECTORY-scoped (`recued-server-identity.json` beside the
 *  db) while the bundle sidecar is DB-scoped by suffix — deliberately, "so two
 *  explicitly named realm dbs in the same directory cannot share encryption
 *  state by accident". But the sidecars are wrapped to the ONE server key that
 *  keyfile holds, so a second realm enrolling in the same directory overwrites
 *  it and the first realm's bundle can never be opened again. Its database is
 *  intact and unreadable.
 *
 *  This is the guard above ("overwrites the only key that opens an existing
 *  bundle") applied one realm over: same destructive write, same reasoning, a
 *  neighbour instead of ourselves.
 *
 *  ⛔ A PURE FILESYSTEM CHECK — the presence of a valid sibling bundle IS the
 *  evidence, not whether the current key opens it. An earlier version asked
 *  "does the current key open a sibling?", which had two holes: (1) it read the
 *  key from the passed keyStore's IN-MEMORY cache, populated at construction, so
 *  a sibling enrolled AFTER this keyStore was built was invisible — the exact
 *  race two concurrent first-enrollments hit; and (2) with no key yet (the first
 *  enrollment) it returned null, seeing nothing. Parsing the sibling sidecar
 *  needs no key and reflects the disk as it is right now (serialized behind the
 *  directory queue, so a sibling's write has landed before we look).
 *
 *  This also RETIRES the old "already-orphaned sibling, don't block" exception:
 *  a sibling that the keyfile no longer opens only arises from two realms having
 *  shared a directory — precisely the state this guard now prevents — so once
 *  one-realm-per-directory is enforced it cannot legitimately occur, and a dir
 *  that already holds another realm's bundle is exactly where a fresh realm must
 *  NOT enrol. */
const siblingRealmSidecarExists = (dbPath: string): string | null => {
  const dir = dirname(resolve(dbPath));
  const ownSidecar = resolveServerBundlePath(dbPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // ⛔ FAIL CLOSED. We cannot list the directory, so we cannot rule out a
    // sibling realm — and the enrollment below writes the DIRECTORY-scoped
    // keyfile. "Can't scan" is NOT "empty": returning null here let a
    // destructive write proceed on unproven ground. Refusing costs a fixable
    // environment error; proceeding could overwrite a sibling realm's only key.
    throw new Error(
      `D212_REALM_WOULD_ORPHAN_SIBLING: cannot scan ${dir} to rule out a sibling realm `
        + 'before the destructive keyfile write. Fix the directory permissions and retry. '
        + `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const entry of entries) {
    if (!entry.endsWith(SERVER_BUNDLE_SIDECAR_SUFFIX)) continue;
    const sidecar = join(dir, entry);
    if (sidecar === ownSidecar) continue;
    const name = entry.slice(0, -SERVER_BUNDLE_SIDECAR_SUFFIX.length);
    // ⛔ Separate the two failures the old single `catch` conflated. An
    // UNREADABLE sidecar is NOT "no sibling": `readdir` listed the file, so it
    // EXISTS — a sibling realm we cannot inspect — and treating that as absence
    // is exactly the fail-open the destructive write below must not ride on.
    let raw: string;
    try {
      raw = readFileSync(sidecar, 'utf8');
    } catch {
      // Present but unreadable ⇒ fail closed, treat as a sibling. (A random
      // unreadable file that merely shares the suffix is a false positive whose
      // cost is a fixable permission error — vs the orphaned realm a false
      // negative would strand.)
      return name;
    }
    try {
      // Parse (not just name-match): a valid bundle is a real neighbouring
      // realm; a file that READS but does not parse is genuinely not one.
      serverBundleFromJSON(raw);
      return name;
    } catch {
      continue; // read fine but not a valid bundle — genuinely not a sibling
    }
  }
  return null;
};

/** First-boot: enrol the server vault from the user's recovery key.
 *  Idempotent — a no-op (`'already_enrolled'`) once a bundle exists, so
 *  a re-pair on an already-encrypted server does nothing. Throws only on
 *  a genuinely bad recovery key (propagated from the KeyManager) — the
 *  caller should fail the pair so a pairing never completes un-encrypted. */
export const enrollServerVaultFromRecoveryKey = async (args: {
  keys: KeyManager;
  keyStore: Pick<ServerKeyStore, 'saveServerVaultKey' | 'flush' | 'loadServerVaultKey'>;
  recoveryKey: string;
  database: Database.Database;
}): Promise<ServerVaultEnrollResult> => {
  const { keys, keyStore, recoveryKey, database } = args;
  const dbPath = database.name;
  // Only the very first pair (no bundle yet) enrols. Locked / unlocked
  // both normally mean "already encrypted". An unlocked manager plus the
  // crash marker means a prior attempt persisted the bundle but did not finish
  // rekeying; retry the exact same domain key instead of reporting success.
  if (keys.state() !== 'uninitialized') {
    if (keys.state() === 'unlocked' && databaseEnrollmentInProgress(dbPath)) {
      rekeyDatabase(database, keys.getSubDEK('database'));
      finishDatabaseEnrollment(dbPath);
      return 'enrolled';
    }
    return 'already_enrolled';
  }

  // …but `state` is in-memory and can disagree with disk. Ask the durable
  // artifact before minting anything: the keyfile write below is destructive
  // and lands BEFORE `initServerVault`'s own guard can refuse, so trusting a
  // drifted `uninitialized` here overwrites the only key that opens an existing
  // bundle. That is the difference between a realm that is merely locked and
  // one that cannot be opened at all.
  if (keys.hasServerBundle()) return 'already_enrolled';

  // …and the same question about the NEIGHBOURS. `hasServerBundle` reads this
  // realm's own sidecar, so it says nothing about a sibling realm wrapped to
  // the very key the write below replaces. Serialized behind the directory
  // queue (see the door), so a concurrent sibling's write has landed first.
  const orphaned = siblingRealmSidecarExists(dbPath);
  if (orphaned) {
    throw new Error(
      `D212_REALM_WOULD_ORPHAN_SIBLING: enrolling ${dbPath} would overwrite the server key that `
        + `opens ${orphaned}, leaving that realm's database intact but unreadable. `
        + 'One realm per data directory — give this one its own directory.',
    );
  }

  const serverKey = generateServerKey();
  beginDatabaseEnrollment(dbPath);
  try {
    // Keyfile first + flush: the auto-unlock secret is durably on disk
    // before the bundle references it. Orphan-on-crash is self-healing.
    keyStore.saveServerVaultKey(serverKey);
    if (keyStore.flush) await keyStore.flush();

    // Persist the dual-wrapped Master DEK before rekeying. The marker lets the
    // next writable boot complete the rekey if the process dies between them.
    await keys.initServerVault({ recoveryKey, serverKey });
    rekeyDatabase(database, keys.getSubDEK('database'));
    finishDatabaseEnrollment(dbPath);
    return 'enrolled';
  } catch (err) {
    // A malformed recovery key creates no bundle and leaves the database
    // plaintext; there is no interrupted encryption transition to recover.
    if (keys.state() === 'uninitialized') finishDatabaseEnrollment(dbPath);
    throw err;
  } finally {
    serverKey.fill(0);
  }
};

// ────────────────────────────────────────────────────────────────
// The door — the one sequence both enrollment surfaces run
// ────────────────────────────────────────────────────────────────

/** In-flight enrollment per database path. The mechanism yields twice
 *  (keyfile flush, `createServerBundle`), and `KeyManager.initServerVault`
 *  checks its orphan guard BEFORE its own await without rechecking after —
 *  so two concurrent first-pairs both pass the guard and race to save.
 *  Serializing at the door is the narrow fix: the loser runs after the
 *  winner has committed and correctly short-circuits on
 *  `state !== 'uninitialized'` / a now-present sentinel. */
const enrollmentChains = new Map<string, Promise<unknown>>();

const runExclusive = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prior = enrollmentChains.get(key) ?? Promise.resolve();
  // Chain off the prior attempt's SETTLEMENT (never its value, and never
  // its rejection) so one failed enrollment cannot poison the queue.
  const run = prior.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  enrollmentChains.set(key, settled);
  try {
    return await run;
  } finally {
    // Drop the slot only if no later caller has chained onto it — compare
    // against the entry THIS call installed, not against `undefined`, which
    // `get` can never return for a key that is present.
    if (enrollmentChains.get(key) === settled) enrollmentChains.delete(key);
  }
};

export type RealmEnrollOutcome =
  /** `enrolled` — no prior sentinel, so the realm is now bound to this key
   *  (and, when the encryption deps are wired, encrypted under it).
   *  `verified` — a prior sentinel existed and this key matched it. */
  | { ok: true; outcome: 'enrolled' | 'verified' }
  /** The key is not this realm's. Nothing was written. */
  | { ok: false; code: 'mismatch'; message: string }
  /** Not a valid 24-word BIP39 mnemonic. Nothing was written. */
  | { ok: false; code: 'invalid'; message: string }
  /** Encryption deps are wired but incomplete — refuse rather than enroll
   *  the gate over a database that would stay plaintext. */
  | { ok: false; code: 'not_configured'; message: string }
  /** This data directory already hosts an enrolled realm, and the keyfile that
   *  opens it is shared by the directory. Enrolling here would overwrite that
   *  key and leave the neighbour's database intact but unreadable.
   *
   *  ⚠ NOT `invalid`. The operator's recovery key is fine; their DIRECTORY is
   *  the problem, and telling someone holding a correct key that it is wrong is
   *  the exact misreport the `busy` code was carved out to stop. */
  | { ok: false; code: 'realm_conflict'; message: string }
  /** Encryption could not be turned on right now, for a reason that is not the
   *  user's key — a WAL checkpoint blocked by an open reader is the live case.
   *  Nothing was bound; retrying is the correct response, and the caller should
   *  say so rather than blaming the credential. */
  | { ok: false; code: 'busy'; message: string };

/** Enroll-or-verify `recoveryKey` against the realm, turning at-rest
 *  encryption on when this is the first enrollment.
 *
 *  Order is the security property, and it is the same at every door:
 *    0. the mnemonic parses. Ahead of the realm verify, which collapses a
 *       malformed key to `mismatch` and would tell someone who mistyped a
 *       word that they have the wrong account.
 *    1a. the BUNDLE — an encrypted realm proves the key opens its recovery
 *       wrap. This is the authoritative anchor and it is checked first.
 *    1b. the SENTINEL — an enrolled realm proves the key matches it too.
 *       Both are read-only and bind nothing. Checking only the sentinel is
 *       not enough: the two can disagree (see below), and a realm in that
 *       state would re-bind to whoever asked next. Checking neither leaves
 *       the vault step reachable in the enrolled-but-unencrypted state,
 *       which turns encryption on under a stranger's key and locks the
 *       owner out of their own data permanently.
 *    2. encryption turns on.
 *    3. the sentinel gate opens — LAST, so it opens only if 1 and 2 held.
 *
 *  ⚠ Steps 2 and 3 are NOT transactional, and cannot cheaply be made so —
 *  one writes a keyfile plus a sidecar, the other a database row. A crash
 *  or a failed sentinel write between them leaves a realm with a bundle and
 *  no sentinel, permanently. That state is why step 1a exists.
 *
 *  Callers are responsible for authenticating the request BEFORE calling:
 *  every step here is durable and realm-binding. */
export const enrollRealmRecoveryKey = async (args: {
  recoveryKeyCheck: RecoveryKeyCheckStore;
  recoveryKey: string;
  /** Encryption deps. All three present ⇒ encryption turns on at the
   *  first enrollment. All three absent ⇒ sentinel-only (db-less test
   *  compositions). Partially present ⇒ `not_configured`, never a
   *  silent sentinel-only enrollment on a server that meant to encrypt. */
  keys?: KeyManager | undefined;
  keyStore?: Pick<ServerKeyStore, 'saveServerVaultKey' | 'flush' | 'loadServerVaultKey'> | undefined;
  database?: Database.Database | undefined;
}): Promise<RealmEnrollOutcome> => {
  const { recoveryKeyCheck, recoveryKey, keys, keyStore, database } = args;
  const { processRecoveryKey, verifyRecoveryKeyAgainstRealm } =
    await import('./recovery-key-processor.js');

  // ⛔ Serialize by the SHARED KEYFILE DIRECTORY, not the db path. The keyfile
  // is directory-scoped (`resolveIdentityKeysPath` = `dirname(db)` + one fixed
  // name), so two dbs in one directory share it — and the sibling-orphan guard
  // below returns null on the FIRST enrollment (no key exists yet to detect).
  // Keyed by db path, two first-enrollments in one directory raced: each guard
  // ran before the other's keyfile write landed, so neither saw a key to orphan,
  // both wrote, and the last write won — leaving one realm's bundle wrapped to a
  // key its keyfile no longer holds (AEAD failure at that realm's next unlock).
  // Keying by the directory forces the SECOND enrollment's guard to run AFTER
  // the first's keyfile exists, where it correctly refuses with `realm_conflict`.
  // Coarser than the old key (dbs in one dir now serialize), never finer, so it
  // cannot drop any serialization the db-path key already provided.
  //
  // ⚠ The chain is IN-PROCESS ONLY. Two SEPARATE server processes sharing a
  // directory are not serialized by a promise queue, and there the guard's
  // check-then-act was a genuine TOCTOU. `withDirectoryReservation` closes it
  // with an `O_EXCL` create — see below for why it nests INSIDE the queue.
  const queueKey = database ? dirname(resolve(database.name)) : '<no-db>';
  return runExclusive<RealmEnrollOutcome>(queueKey, async () => {
    // 0 — parse before the realm verify, which cannot tell a malformed
    // mnemonic from a stranger's and reports both as `mismatch`.
    if (!isValidRecoveryKey(recoveryKey)) {
      return {
        ok: false,
        code: 'invalid',
        message: 'Recovery key is not a valid 24-word recovery phrase.',
      };
    }

    // 1 — an enrolled realm must match before anything durable happens.
    //
    // A realm has TWO anchors and either alone is insufficient. The sentinel is
    // the cheap one, but it can be absent while the vault bundle exists — the
    // gap between step 2 and step 3 below is not transactional, so a crash or a
    // failed sentinel write leaves exactly that state, permanently. Checking
    // only the sentinel there would skip this gate entirely and let step 3
    // enrol whoever asked next: the owner's real key then reads as `mismatch`
    // everywhere (here AND at the archive realm gate) while the stranger's key
    // matches and pairs with no pairing code at all, against a running,
    // unlocked, encrypted server.
    //
    // So the BUNDLE is authoritative whenever one exists: the supplied key must
    // open its recovery wrap. The sentinel check still runs for realms that
    // have one, and covers the un-encrypted (`keys`-less) compositions.
    if (keys && !(await keys.verifyRecoveryKey(recoveryKey))) {
      return {
        ok: false,
        code: 'mismatch',
        message: 'Recovery key does not match this server\'s account.',
      };
    }
    if (recoveryKeyCheck.exists()) {
      if (await verifyRecoveryKeyAgainstRealm(recoveryKeyCheck, recoveryKey) === 'mismatch') {
        return {
          ok: false,
          code: 'mismatch',
          message: 'Recovery key does not match this server\'s account.',
        };
      }
    }

    // 2 — encryption on. `keys` is the marker for "this server encrypts";
    // a missing companion dep is a wiring bug, so refuse loudly.
    if (keys) {
      if (!keyStore || !database) {
        return {
          ok: false,
          code: 'not_configured',
          message: 'Server database encryption handle is unavailable.',
        };
      }
      // ⛔ D-212 §7.9 RETRACTED — enrollment does NOT gate on keyfile sealing.
      //
      // A `keyfile_sealing_required` refusal used to live here, on the reasoning
      // that a realm must not become encrypted while the key that opens it lies
      // in the clear beside it. Sound in the abstract; measured against what
      // ships it refused essentially every headless Linux install, told the
      // operator to set a passphrase that is documented nowhere, and the
      // webclient replaced the message with "check the URL". Following it
      // bricked the server.
      //
      // §7.10 moves the decision to first boot, where the keyfile is still
      // disposable, and enforces the floor by making the posture legible rather
      // than by refusing. An unsealed realm here is the operator's informed
      // choice, not a state the server has to prevent.
      try {
        // ⛔ The cross-process half of the serialization, and it nests INSIDE
        // the in-process queue on purpose. Outside it, two enrollments in this
        // same process would contend for the `O_EXCL` file and one would get a
        // spurious `busy` for a race the queue already resolves correctly.
        // Inside, the file only ever arbitrates between DIFFERENT processes —
        // which is the only case a promise chain cannot see.
        //
        // It wraps exactly the destructive span: the sibling scan and the
        // directory-scoped keyfile write live together in
        // `enrollServerVaultFromRecoveryKey`, and a reservation that ended
        // between them would leave the check-then-act it exists to close.
        await withDirectoryReservation(
          dirname(resolve(database.name)),
          () => enrollServerVaultFromRecoveryKey({ keys, keyStore, recoveryKey, database }),
        );
      } catch (err) {
        if (err instanceof DirectoryReservationHeldError) {
          // Another process is mid-enrollment on this directory. `busy` is
          // exactly right: nothing was bound, the operator's key is fine, and
          // retrying is the correct response — the same shape as a WAL
          // checkpoint blocked by an open reader.
          return { ok: false, code: 'busy', message: err.message };
        }
        // The key itself was already proven above, so a failure here is the
        // machinery, not the credential. Reporting it as `invalid` told a user
        // holding their correct recovery key that it was wrong — and the most
        // likely cause is transient: a WAL checkpoint that could not complete
        // because a reader was still open.
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          code: message.includes('D212_DATABASE_REKEY_BUSY')
            ? 'busy'
            : message.includes('D212_REALM_WOULD_ORPHAN_SIBLING')
              ? 'realm_conflict'
              : 'invalid',
          message,
        };
      }
    }

    // 3 — the gate opens last.
    const verify = await processRecoveryKey(recoveryKeyCheck, recoveryKey);
    if (verify.ok) return { ok: true, outcome: verify.outcome };
    return { ok: false, code: verify.code, message: verify.message };
  });
};

/** Boot: auto-unlock the vault from the keyfile-held server key. No-op
 *  (`'skipped'`) unless the manager is `locked` (a bundle is persisted)
 *  AND a server key is present in the keyfile — so a fresh / password-only
 *  realm is untouched. A wrong or tampered key propagates (the caller
 *  should surface it rather than silently run locked). */
export const autoUnlockServerVaultFromKeyfile = async (args: {
  keys: KeyManager;
  keyStore: Pick<ServerKeyStore, 'loadServerVaultKey'>;
}): Promise<ServerVaultUnlockResult> => {
  const { keys, keyStore } = args;
  if (keys.state() !== 'locked') return 'skipped';
  const serverKey = keyStore.loadServerVaultKey();
  if (!serverKey) return 'skipped';
  try {
    await keys.unlockWithServerKey({ serverKey });
  } finally {
    // The store hands back a fresh copy and the unlock does not take
    // ownership, so this buffer is ours alone to clear — same as the enroll
    // path above. Without it the auto-unlock factor lingers in the heap for
    // the whole process lifetime, on every boot.
    serverKey.fill(0);
  }
  return 'unlocked';
};
