/** Crash-consistent restore swap for the realm db + D-212 bundle sidecar.
 *
 * A filesystem cannot atomically rename two files. Restoring the db and then
 * the dual-wrapped Master-DEK sidecar (or the reverse) therefore has a crash
 * window where boot could observe a mismatched pair. This tiny journal closes
 * that window:
 *
 *   - while the staged db still exists, recovery rolls the old pair back;
 *   - once the staged db has been renamed onto the live path, recovery
 *     finishes publishing the new sidecar;
 *   - boot reconciles the journal before either SQLite or the sidecar opens.
 *
 * The marker stores only a strictly validated basename + booleans. It never
 * supplies an arbitrary filesystem path, so corrupt/tampered marker contents
 * cannot redirect restore renames outside the realm db directory.
 *
 * ⛔ THE JOURNAL ALSO OWNS THE RESTORE'S CAS PARKS. A restore that overlays a
 * live blob object parks the pre-restore original beside it, and whether that
 * park is dead weight or the bytes the live database still references is
 * decided by exactly one thing: did this swap commit. The marker is the only
 * durable record of that answer, so a park MUST NOT outlive it — reaping them
 * after the marker was released left "park present, no marker" on disk, which
 * the next boot reads as an uncommitted restore and renames the PRE-restore
 * bytes back over the objects the NEW database references. Every path that
 * releases the marker therefore resolves the parks first, via the injected
 * `reclaimParks`; a park that could not be resolved KEEPS the marker, so boot
 * reconciles forward and finishes the job with the right verdict.
 *
 * How far "crash-consistent" reaches: a process crash is fully covered, since
 * every step is a rename and the journal makes both directions recoverable.
 * Power loss is covered as far as the platform allows — the marker write and
 * each batch of renames fsync the realm db directory (`durable-fs`), so the
 * directory entries land with the bytes. That fsync is best-effort and a no-op
 * where a directory cannot be opened for it (Windows), and there the guarantee
 * narrows back to process-crash safety.
 *
 * ⚠ THE CAS PARKS THIS JOURNAL DECIDES LIVE IN A DIFFERENT DIRECTORY TREE
 * (`<data>/{blobs,cache_blobs,memory_blobs}/objects/<shard>/`), so the realm-dir
 * fsync above says nothing about them. Their durability is the SAME best-effort
 * shard-dir fsync, applied where it matters in `archive-restore`: on park
 * creation (before the overlay overwrites — the rollback ordering), on the
 * overlay itself (before the swap commits — the committed reference), and on
 * park reap/rollback (inside `reclaimParks`, before the marker is released). So
 * both halves of a restore reach the same power-loss floor, not just the db.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fsyncDir } from '../durable-fs.js';
import { resolveServerBundlePath } from '../server-bundle-store.js';

const MARKER_SUFFIX = '.restore-server-bundle-swap.json';
const MARKER_VERSION = 1;
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export interface BundleSwapMarker {
  v: 1;
  staging_name: string;
  stamp: string;
  has_next_bundle: boolean;
  had_db: boolean;
  had_wal: boolean;
  had_shm: boolean;
  had_bundle: boolean;
}

export interface PreparedServerBundleSwap {
  readonly dbPath: string;
  readonly stagingDbPath: string;
  readonly markerPath: string;
  readonly bundlePath: string;
  readonly stagedBundlePath: string;
  readonly dbBackupPath: string;
  readonly walBackupPath: string;
  readonly shmBackupPath: string;
  readonly bundleBackupPath: string;
  readonly marker: BundleSwapMarker;
}

export interface ServerBundleSwapCommitResult {
  readonly dbBackupPath: string | null;
  readonly backups: string[];
}

export type ServerBundleSwapRecovery = 'none' | 'rolled_back' | 'completed';

export interface ServerBundleSwapReconcileResult {
  /** What the journal DECIDED — which direction the interrupted swap was
   *  resolved in. This is about the db + sidecar pair, and it is final. */
  readonly recovery: ServerBundleSwapRecovery;
  /** Whether the journal was RETIRED — the marker is gone and this realm owes
   *  nothing further.
   *
   *  ⛔ NOT implied by `recovery`. When a park cannot be resolved the marker is
   *  deliberately KEPT so the next boot can re-decide with the verdict still
   *  attached — the repair happened, the journal did not retire. Returning only
   *  `'completed'` made those two look identical, and `applyRestore` read the
   *  verdict as "settled", streamed a whole archive onto an unsettled realm,
   *  and was refused by `prepareServerBundleSwap` only afterwards — leaking the
   *  staged db AND leaving its blob overlay in the CAS with the parks
   *  un-rolled-back, under the OLD database that still references them.
   *
   *  Anything about to start NEW work on this realm must gate on `retired`.
   *  Boot may proceed on `false`: a park it cannot move must never fail a boot,
   *  and the marker simply waits. */
  readonly retired: boolean;
}

/** Resolve the CAS parks belonging to the swap being decided, given the
 *  journal's verdict: `true` — the archive's objects are live now, so the parks
 *  are dead weight; `false` — the OLD database survived and still references
 *  the parked bytes, so they go back.
 *
 *  Injected rather than imported: the parks are an archive-layer concept and
 *  this module sits UNDER that layer (`archive-restore` imports it, not the
 *  reverse). Required, not optional — a caller that forgot it would silently
 *  reopen the window this journal exists to close.
 *
 *  ⚠ It must resolve the parks OF THE TRANSACTION BEING RECONCILED. Passing a
 *  different restore's park list is worse than passing none: reconciling an
 *  older interrupted swap would then roll back the CURRENT restore's overlay
 *  mid-flight. That is why `prepareServerBundleSwap` no longer reconciles —
 *  see the note there.
 *
 *  ⛔ RETURNS whether EVERY park was resolved, and that answer is load-bearing:
 *  the marker is released only on `true`. The park helpers are best-effort by
 *  design (a park we cannot move must not fail a boot) — so without a report,
 *  "best effort" would silently mean "the marker goes anyway", stranding a park
 *  with no journal to interpret it. That is the original defect through a
 *  rarer door. On `false` the journal is kept and the next boot re-decides. */
export type ReclaimSwapParks = (committed: boolean) => boolean;

export const resolveServerBundleSwapMarkerPath = (dbPath: string): string =>
  `${resolve(dbPath)}${MARKER_SUFFIX}`;

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
};

const writeAtomic = (path: string, body: Buffer, mode: number): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.tmp-${basename(path)}-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  try {
    const fd = openSync(tmpPath, 'wx', mode);
    try {
      let offset = 0;
      while (offset < body.length) {
        const written = writeSync(fd, body, offset, body.length - offset, null);
        if (written === 0) throw new Error(`short write while publishing ${path}`);
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, path);
    // The marker + staged bundle are the journal recovery reads after a crash,
    // so the NAME has to survive the crash too — fsyncing the bytes alone
    // leaves the directory entry the rename created still only in page cache.
    fsyncDir(dir);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
    throw err;
  }
};

const markerBytes = (marker: BundleSwapMarker): Buffer =>
  Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

const parseMarker = (dbPath: string, raw: string): BundleSwapMarker => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_INVALID: malformed marker for ${dbPath}: `
        + (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_INVALID: marker for ${dbPath} is not an object`,
    );
  }
  const marker = value as Partial<BundleSwapMarker>;
  const dbName = basename(dbPath);
  const escapedDbName = dbName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const onlineName = new RegExp(
    `^${escapedDbName}\\.staging-[0-9a-f]{16}$`,
  );
  const offlineName = new RegExp(
    `^${escapedDbName}\\.restore-[0-9a-f]{16}\\.tmp$`,
  );
  const validStamp = typeof marker.stamp === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/.test(marker.stamp);
  if (
    marker.v !== MARKER_VERSION
    || typeof marker.staging_name !== 'string'
    || (!onlineName.test(marker.staging_name) && !offlineName.test(marker.staging_name))
    || !validStamp
    || !isBoolean(marker.has_next_bundle)
    || !isBoolean(marker.had_db)
    || !isBoolean(marker.had_wal)
    || !isBoolean(marker.had_shm)
    || !isBoolean(marker.had_bundle)
  ) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_INVALID: marker for ${dbPath} has an invalid shape`,
    );
  }
  return marker as BundleSwapMarker;
};

const transactionFromMarker = (
  dbPathInput: string,
  marker: BundleSwapMarker,
): PreparedServerBundleSwap => {
  const dbPath = resolve(dbPathInput);
  const stagingDbPath = join(dirname(dbPath), marker.staging_name);
  const bundlePath = resolveServerBundlePath(dbPath);
  return {
    dbPath,
    stagingDbPath,
    markerPath: resolveServerBundleSwapMarkerPath(dbPath),
    bundlePath,
    stagedBundlePath: resolveServerBundlePath(stagingDbPath),
    dbBackupPath: `${dbPath}.bak-${marker.stamp}`,
    walBackupPath: `${dbPath}-wal.bak-${marker.stamp}`,
    shmBackupPath: `${dbPath}-shm.bak-${marker.stamp}`,
    bundleBackupPath: `${bundlePath}.bak-${marker.stamp}`,
    marker,
  };
};

const readTransaction = (dbPath: string): PreparedServerBundleSwap | null => {
  const resolvedDbPath = resolve(dbPath);
  const markerPath = resolveServerBundleSwapMarkerPath(resolvedDbPath);
  if (!existsSync(markerPath)) return null;
  const marker = parseMarker(resolvedDbPath, readFileSync(markerPath, 'utf8'));
  return transactionFromMarker(resolvedDbPath, marker);
};

const sameTransaction = (
  expected: PreparedServerBundleSwap,
  actual: PreparedServerBundleSwap,
): boolean =>
  expected.dbPath === actual.dbPath
  && expected.stagingDbPath === actual.stagingDbPath
  && expected.marker.stamp === actual.marker.stamp;

const assertPathState = (
  path: string,
  shouldExist: boolean,
  label: string,
): void => {
  if (existsSync(path) !== shouldExist) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: ${label} at ${path} `
        + `${shouldExist ? 'disappeared' : 'appeared'} after restore staging`,
    );
  }
};

const assertBackupTargetsFree = (tx: PreparedServerBundleSwap): void => {
  for (const path of [
    tx.dbBackupPath,
    tx.walBackupPath,
    tx.shmBackupPath,
    tx.bundleBackupPath,
  ]) {
    if (existsSync(path)) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_BACKUP_EXISTS: refusing to overwrite ${path}`,
      );
    }
  }
};

/** Reconcile an interrupted db + bundle-sidecar swap before either is opened.
 *  `reclaimParks` resolves the restore's CAS parks under the verdict reached
 *  here, while the marker still exists — see the module header. */
export const reconcileServerBundleSwap = (
  dbPathInput: string,
  reclaimParks: ReclaimSwapParks,
): ServerBundleSwapReconcileResult => {
  const tx = readTransaction(dbPathInput);
  // No journal at all — nothing to decide and nothing left owing.
  if (!tx) return { recovery: 'none', retired: true };

  const stagingExists = existsSync(tx.stagingDbPath);
  const liveExists = existsSync(tx.dbPath);

  if (!stagingExists) {
    // The staged-db rename is the commit point. Once it has landed, the live db
    // is the NEW db; finish (or confirm) publication of its matching bundle.
    if (!liveExists) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: neither live nor staged db exists for ${tx.dbPath}`,
      );
    }
    if (tx.marker.has_next_bundle) {
      const stagedBundleExists = existsSync(tx.stagedBundlePath);
      const liveBundleExists = existsSync(tx.bundlePath);
      if (stagedBundleExists && !liveBundleExists) {
        renameSync(tx.stagedBundlePath, tx.bundlePath);
      } else if (stagedBundleExists === liveBundleExists) {
        throw new Error(
          `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: expected exactly one new bundle copy for ${tx.dbPath}`,
        );
      }
    } else if (existsSync(tx.bundlePath) || existsSync(tx.stagedBundlePath)) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: keyless restore retained a bundle for ${tx.dbPath}`,
      );
    }
    // Same ordering rule the commit follows: the repair has to be durable
    // before the marker that would replay it is dropped. The parks are part of
    // that repair — the archive's objects are the live ones now, so the parked
    // originals are dead weight, and this marker is the only thing that still
    // knows it.
    fsyncDir(dirname(tx.dbPath));
    // Only release the journal once the parks are actually gone. A park that
    // survived here with the marker deleted is unreadable state: the next boot
    // sees "park, no marker" and rolls PRE-restore bytes over the new database.
    const retired = reclaimParks(true);
    if (retired) unlinkSync(tx.markerPath);
    return { recovery: 'completed', retired };
  }

  // The new db has NOT reached the live path. Restore the old pair. Each
  // artifact is either still live (the move never happened) or at its backup
  // path (the move happened); any other combination is fail-closed ambiguity.
  const restoreOld = (
    livePath: string,
    backupPath: string,
    existedBefore: boolean,
    label: string,
  ): void => {
    const live = existsSync(livePath);
    const backup = existsSync(backupPath);
    if (live && backup) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: both live and backup ${label} exist for ${tx.dbPath}`,
      );
    }
    if (existedBefore) {
      if (!live && !backup) {
        throw new Error(
          `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: old ${label} is missing for ${tx.dbPath}`,
        );
      }
      if (backup) renameSync(backupPath, livePath);
    } else if (live || backup) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: unexpected ${label} appeared for ${tx.dbPath}`,
      );
    }
  };

  restoreOld(tx.dbPath, tx.dbBackupPath, tx.marker.had_db, 'db');
  restoreOld(`${tx.dbPath}-wal`, tx.walBackupPath, tx.marker.had_wal, 'WAL');
  restoreOld(`${tx.dbPath}-shm`, tx.shmBackupPath, tx.marker.had_shm, 'SHM');
  restoreOld(tx.bundlePath, tx.bundleBackupPath, tx.marker.had_bundle, 'bundle');

  // Remove the marker BEFORE deleting the new staged db. If cleanup is
  // interrupted, boot sees a valid old pair plus a harmless orphan rather than
  // mistaking "staging missing" for a committed new db. The rollback renames
  // are fsynced first so the marker never disappears ahead of the state it
  // describes — and the parks go back first for the same reason: the OLD
  // database is the one that survived, and it references the parked bytes.
  // Re-entrant on purpose: a crash here leaves the marker AND the staged db, so
  // the next reconcile takes this same branch and finishes the remainder.
  fsyncDir(dirname(tx.dbPath));
  // ⛔ Marker AND staged db are kept together when a park could not be put
  // back. This branch is SELECTED by the staged db existing, so dropping the
  // staging while keeping the marker would send the next reconcile down the
  // COMMITTED branch — reaping the very parks that still have to be restored.
  // They are one signal; they retire together or not at all.
  if (!reclaimParks(false)) return { recovery: 'rolled_back', retired: false };
  unlinkSync(tx.markerPath);
  for (const path of [
    tx.stagingDbPath,
    `${tx.stagingDbPath}-wal`,
    `${tx.stagingDbPath}-shm`,
    tx.stagedBundlePath,
  ]) {
    try { unlinkIfPresent(path); } catch { /* old live pair is already safe */ }
  }
  return { recovery: 'rolled_back', retired: true };
};

/** Stage the next bundle and durable marker before moving any live artifact. */
export const prepareServerBundleSwap = (args: {
  dbPath: string;
  stagingDbPath: string;
  stamp: string;
  nextBundle?: Buffer;
}): PreparedServerBundleSwap => {
  const dbPath = resolve(args.dbPath);
  const stagingDbPath = resolve(args.stagingDbPath);
  if (dirname(stagingDbPath) !== dirname(dbPath)) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_INVALID: staged db must be beside ${dbPath}`,
    );
  }
  if (!existsSync(stagingDbPath)) {
    throw new Error(
      `ARCHIVE_RESTORE_STAGING_MISSING: expected staged db at ${stagingDbPath}`,
    );
  }

  // ⛔ A PRECONDITION, not a repair. This used to call
  // `reconcileServerBundleSwap` itself — "an offline restore can run without a
  // prior server boot, so resolve any earlier interrupted swap here too" — and
  // that reasoning is right about the NEED but wrong about the PLACE. By the
  // time prepare runs, the caller has already streamed the archive: blobs are
  // overlaid and parked, and the encryption-posture gate has already been
  // evaluated. Reconciling here therefore (a) judged the posture against a
  // realm whose bundle was still parked under an older swap's backup name,
  // letting a keyless archive walk past the downgrade refusal, and (b) had no
  // way to resolve the older swap's parks without also unwinding THIS
  // restore's. The caller reconciles BEFORE it streams; this stays as the
  // fail-closed check that it did.
  if (existsSync(resolveServerBundleSwapMarkerPath(dbPath))) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: an unreconciled swap marker exists for ${dbPath}; `
        + 'reconcile it before staging a new restore',
    );
  }

  const marker: BundleSwapMarker = {
    v: MARKER_VERSION,
    staging_name: basename(stagingDbPath),
    stamp: args.stamp,
    has_next_bundle: args.nextBundle !== undefined,
    had_db: existsSync(dbPath),
    had_wal: existsSync(`${dbPath}-wal`),
    had_shm: existsSync(`${dbPath}-shm`),
    had_bundle: existsSync(resolveServerBundlePath(dbPath)),
  };
  // Encryption-posture invariant, re-derived from the EXACT fields the commit
  // will act on rather than from a filesystem probe taken earlier in the
  // restore. `had_bundle && !has_next_bundle` is precisely "park the realm's
  // Master-DEK sidecar and publish nothing in its place" — an encrypted realm
  // silently becoming a plaintext one. The streaming gate in `archive-restore`
  // states the same rule in operator terms and catches it before any work is
  // done; this is the last line, and it holds even if the state it checked has
  // moved underneath it.
  if (marker.had_bundle && !marker.has_next_bundle) {
    throw new Error(
      'D212_REALM_DOWNGRADE_REFUSED: this restore would remove the realm\'s server vault bundle '
        + `without publishing a replacement, leaving ${dbPath} in plaintext`,
    );
  }
  // Validate the generated names/stamp through the exact same boundary used
  // after a crash; this prevents an implementation change from writing an
  // unrecoverable marker.
  const tx = transactionFromMarker(dbPath, parseMarker(dbPath, JSON.stringify(marker)));
  assertBackupTargetsFree(tx);
  if (existsSync(tx.stagedBundlePath)) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: staged bundle already exists at ${tx.stagedBundlePath}`,
    );
  }

  try {
    if (args.nextBundle !== undefined) {
      writeAtomic(tx.stagedBundlePath, args.nextBundle, 0o600);
    }
    writeAtomic(tx.markerPath, markerBytes(marker), 0o600);
  } catch (err) {
    try { unlinkIfPresent(tx.stagedBundlePath); } catch { /* best effort */ }
    throw err;
  }
  return tx;
};

/** Commit a prepared pair. Errors before the db commit point roll back; errors
 *  after it are reconciled forward so a successful return always means the db
 *  and bundle sidecar match. */
export const commitPreparedServerBundleSwap = (
  prepared: PreparedServerBundleSwap,
  reclaimParks: ReclaimSwapParks,
): ServerBundleSwapCommitResult => {
  const disk = readTransaction(prepared.dbPath);
  if (!disk || !sameTransaction(prepared, disk)) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: prepared marker changed for ${prepared.dbPath}`,
    );
  }
  const tx = disk;

  const backups = [
    ...(tx.marker.had_db ? [tx.dbBackupPath] : []),
    ...(tx.marker.had_wal ? [tx.walBackupPath] : []),
    ...(tx.marker.had_shm ? [tx.shmBackupPath] : []),
    ...(tx.marker.had_bundle ? [tx.bundleBackupPath] : []),
  ];
  const result: ServerBundleSwapCommitResult = {
    dbBackupPath: tx.marker.had_db ? tx.dbBackupPath : null,
    backups,
  };

  try {
    assertBackupTargetsFree(tx);
    assertPathState(tx.dbPath, tx.marker.had_db, 'live db');
    assertPathState(`${tx.dbPath}-wal`, tx.marker.had_wal, 'live WAL');
    assertPathState(`${tx.dbPath}-shm`, tx.marker.had_shm, 'live SHM');
    assertPathState(tx.bundlePath, tx.marker.had_bundle, 'live bundle');
    assertPathState(tx.stagingDbPath, true, 'staged db');
    assertPathState(
      tx.stagedBundlePath,
      tx.marker.has_next_bundle,
      'staged bundle',
    );

    if (tx.marker.had_db) renameSync(tx.dbPath, tx.dbBackupPath);
    if (tx.marker.had_wal) renameSync(`${tx.dbPath}-wal`, tx.walBackupPath);
    if (tx.marker.had_shm) renameSync(`${tx.dbPath}-shm`, tx.shmBackupPath);
    if (tx.marker.had_bundle) renameSync(tx.bundlePath, tx.bundleBackupPath);

    // Commit point: after this rename, crash recovery completes FORWARD.
    renameSync(tx.stagingDbPath, tx.dbPath);
    if (tx.marker.has_next_bundle) {
      renameSync(tx.stagedBundlePath, tx.bundlePath);
    }
    // Every rename above lands in the realm db's directory (the staged db is
    // required to be a sibling, and both bundle paths derive from a db path).
    // fsync it once, BEFORE the marker goes away: the marker is what tells the
    // next boot to finish the job, so it must not outlive the renames it
    // describes only in page cache.
    fsyncDir(dirname(tx.dbPath));
    // The archive's blobs are authoritative from the commit point above, so the
    // parked originals are dead weight — but ONLY this marker still knows that.
    // Reaping them after releasing it left a window where a kill in between
    // produced "parks present, no marker", which boot reads as an uncommitted
    // restore and rolls the PRE-restore bytes back over the objects the new
    // database references. Inside the journal, a kill here simply leaves the
    // marker for boot to reconcile forward.
    if (reclaimParks(true)) unlinkSync(tx.markerPath);
  } catch (err) {
    let recovery: ServerBundleSwapReconcileResult;
    try {
      // Pre-commit failures roll back; post-commit failures finish forward.
      // Same park list either way — this is OUR transaction, so its verdict is
      // exactly the one those parks are waiting on.
      recovery = reconcileServerBundleSwap(tx.dbPath, reclaimParks);
    } catch (recoveryErr) {
      throw new AggregateError(
        [err, recoveryErr],
        `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: automatic recovery failed for ${tx.dbPath}`,
      );
    }
    if (recovery.recovery === 'completed') return result;
    throw err;
  }

  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try { unlinkIfPresent(`${tx.stagingDbPath}${suffix}`); } catch { /* best effort */ }
  }
  return result;
};
