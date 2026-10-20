/** Writable application entry point. Reconcile rollback evidence and retain
 * the pre-upgrade generation before any store or registered migration runs.
 * Raw archive/recovery/read-only opens use openDatabase instead. */
import type Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BootTrace } from './cli/boot-trace.js';
import { copyDatabaseForSnapshot, openDatabase } from './open-database.js';
import { DATABASE_SCHEMA_VERSION, migrateDatabaseSchema, readDatabaseSchema } from './database-schema.js';
import { createInstanceLock } from './lifecycle/instance-lock.js';
import { SERVER_VERSION } from './server-version.js';
import { deriveInFlightEntry } from './update/apply-orchestrator.js';
import {
  legacyRealmSnapshotPath, prepareRealmForRelease, readReleaseGenerationTransition,
  realmSnapshotMatchesTransition, realmSnapshotPath, snapshotRealmOnNewRelease,
  writeReleaseGenerationTransition,
} from './update/realm-generation-snapshot.js';
import {
  completeSnapshotReceiptEpochAfterKeyedOpen, consumePendingSnapshotRestore,
  markSnapshotRestorePending, reconcileSnapshotReceiptEpochBeforeOpen,
} from './update/binary-apply-executor.js';
import { resolveUpdateBinaryPath } from './update/install-paths.js';
import { createUpdateLedger, UPDATE_LEDGER_FILE } from './update/update-ledger.js';

const storagePathIdentity = (path: string): string => {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export const openApplicationDatabase = async (options: {
  dbPath: string;
  bootTrace?: BootTrace;
  restoreJournalReconciled?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<Database.Database> => {
  const { dbPath, bootTrace } = options;
  const env = options.env ?? process.env;
  // A CLI may share the running server's already-current database. It must
  // not reconcile a generation rollback, replace a snapshot, or start a schema
  // upgrade underneath that process. Normal update/boot owns that downtime.
  const holder = createInstanceLock({ lockPath: join(dirname(dbPath), 'recued-server.lock') }).inspect();
  let anotherServerIsLive = false;
  if (holder && holder.pid !== process.pid) {
    try { process.kill(holder.pid, 0); anotherServerIsLive = true; }
    catch (error) { anotherServerIsLive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  if (anotherServerIsLive) {
    bootTrace?.markDbOpenAttempted('configured-db-path');
    const shared = await openDatabase(dbPath, { keyEnvironment: env });
    try {
      if (readDatabaseSchema(shared).version !== DATABASE_SCHEMA_VERSION) {
        throw new Error('DATABASE_SCHEMA_UPGRADE_SERVER_LIVE: restart the server with this binary to finish its schema upgrade before using this CLI');
      }
      shared.pragma('journal_mode = WAL');
      shared.pragma('foreign_keys = ON');
      bootTrace?.mark('db-opened');
      return shared;
    } catch (error) { shared.close(); throw error; }
  }
  // A snapshot restore can rewind receipt change sequences. Its two-phase
  // journal is reconciled before the first handle, then completed only after
  // the canonical encrypted/keyless open has supplied the correct key.
  reconcileSnapshotReceiptEpochBeforeOpen(dbPath);

  // ⛔ BEFORE THE FIRST DATABASE HANDLE. A rollback swaps the host executable,
  // not one realm, so a realm that did not initiate it may still hold the newer
  // schema. Its generation-bound snapshot is the only safe bridge back.
  const updateBinaryPath = resolveUpdateBinaryPath(env);
  let transition = readReleaseGenerationTransition(updateBinaryPath);

  // A deployed N-1 release predates the host-generation witness but still left
  // a complete apply ledger and pre-migration snapshot. Reconstruct the exact
  // transition before downgrade preparation or the first database handle, so a
  // stale scoped marker cannot make recovery refuse before it sees the proof.
  // A malformed or unreadable ledger remains fail-closed below.
  let inFlightApply = false;
  try {
    const ledgerPath = join(dirname(resolve(dbPath)), UPDATE_LEDGER_FILE);
    if (existsSync(ledgerPath)) {
      const entry = deriveInFlightEntry(createUpdateLedger(ledgerPath));
      if (entry !== null) {
        if (
          transition === null
          && entry.to_version === SERVER_VERSION
          && typeof entry.migration === 'boolean'
        ) {
          transition = {
            schema: 1,
            from_version: entry.from_version,
            to_version: entry.to_version,
            migration: entry.migration,
          };
          writeReleaseGenerationTransition(updateBinaryPath, transition);
        }
        const scopedSnapshot = storagePathIdentity(realmSnapshotPath(dbPath));
        const legacySnapshot = storagePathIdentity(legacyRealmSnapshotPath(dbPath));
        const declaredSnapshot = typeof entry.snapshot_ref === 'string'
          ? storagePathIdentity(entry.snapshot_ref)
          : null;
        if (declaredSnapshot === scopedSnapshot) {
          inFlightApply = true;
        } else if (
          entry.migration === true
          && (declaredSnapshot === null || declaredSnapshot === legacySnapshot)
        ) {
          // A deployed N-1 entry did not carry a scoped owner. While its flat
          // snapshot exists, the snapshot module performs the conservative
          // single-SQLite-realm proof. After adoption, only the realm whose
          // scoped metadata matches this transition remains the applying realm.
          inFlightApply = existsSync(legacySnapshot)
            || (transition !== null && realmSnapshotMatchesTransition(dbPath, transition));
        }
      }
    }
  } catch {
    // Unreadable means an apply may be in flight. Skipping a fresh snapshot is
    // safer than overwriting a real pre-migration recovery copy before DDL.
    inFlightApply = true;
  }

  const prepared = await prepareRealmForRelease({
    dbPath,
    releaseIdentity: SERVER_VERSION,
    transition,
    restoreSnapshot: (snapshotPath) => {
      markSnapshotRestorePending(dbPath, snapshotPath);
      const restored = consumePendingSnapshotRestore(
        dbPath,
        (from, to) => copyFileSync(from, to),
        (message) => console.error(`[update] ${message}`),
      );
      if (!restored.restored) throw new Error('the generation-bound snapshot restore did not complete');
    },
  });
  if (prepared.action === 'downgrade-prepared') {
    console.error(
      `[update] prepared this realm for host rollback ${prepared.from} → ${prepared.to}`
      + (prepared.restoredSnapshot ? ' (pre-migration snapshot restored)' : ''),
    );
  }

  bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = await openDatabase(dbPath, {
    restoreJournalReconciled: options.restoreJournalReconciled === true,
    keyEnvironment: env,
  });
  try {
    completeSnapshotReceiptEpochAfterKeyedOpen(dbPath, db);
    db.pragma('journal_mode = WAL');
    // D-212 slice 0 — the page-cache ceiling. Ships independently of the rest of
    // the at-rest-encryption arc because it is a free win TODAY and it is what
    // makes every later step of that arc cost ~nothing on reads.
    //
    // SQLite's default is ~2 MB, which is the worst case for a workload like this
    // one: `records`-shaped tables plus FTS5, where a scan re-reads the same pages.
    // Measured (`scripts/bench-at-rest-encryption.mjs`, 20k rows), encrypted vs
    // plain at the DEFAULT cache: timeline scan +131%, warm point read +212%,
    // FTS5 +8.3%. At 20 MB every one of those is statistical NOISE, and by 64 MB
    // writes fall from +30% to +5.4%. Unencrypted it is simply free headroom.
    //
    // ⚠ NEGATIVE value = KIBIBYTES (SQLite convention), not pages. And it is a
    // CEILING, not a reservation: the page cache grows lazily, so a small database
    // on a constrained 1-click VPS never allocates 64 MB. Lower it only if a host
    // genuinely cannot spare the ceiling.
    db.pragma('cache_size = -64000');
    db.pragma('foreign_keys = ON');
    bootTrace?.mark('db-opened');

    // ⛔ BEFORE ANY STORE IS CONSTRUCTED. Store setup is what runs the schema DDL,
    // and not all of it is additive — it DROPs columns. A realm meeting a binary
    // generation it has never run gets its own pre-migration copy first, so the
    // ordinary "stop the server, back up, update, restore" workflow and a second
    // `--db` path are covered by the same rule. `realm-generation-snapshot.ts`
    // says why the realm that ran the update is deliberately excluded.
    await snapshotRealmOnNewRelease({
      dbPath,
      releaseIdentity: SERVER_VERSION,
      transition,
      hasInFlightApply: () => inFlightApply,
      takeSnapshot: (destination) => copyDatabaseForSnapshot(db, destination),
    });

    migrateDatabaseSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};
