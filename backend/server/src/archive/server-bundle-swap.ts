/** Crash-consistent restore swap for the realm db, config, and D-212 bundle.
 *
 * A filesystem cannot atomically rename multiple files (some config paths can
 * even live on another filesystem). Restoring the db, config, and dual-wrapped
 * Master-DEK sidecar therefore has crash windows where boot could observe a
 * mismatched set. This journal closes them:
 *
 *   - while the staged db still exists, recovery rolls the old pair back;
 *   - once the staged db has been renamed onto the live path, recovery
 *     finishes publishing the new config and sidecar;
 *   - config is projected before the boot config snapshot escapes, and the full
 *     journal is reconciled before either SQLite or the sidecar opens.
 *
 * The marker stores a strictly validated db basename and a hash binding the
 * caller-supplied config path; it never supplies an arbitrary filesystem path,
 * so corrupt/tampered marker contents cannot redirect restore renames.
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
 * each batch of renames fsync the realm db and config directories
 * (`durable-fs`), so the directory entries land with the bytes. That fsync is
 * best-effort and a no-op
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

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fsyncDir, writeFileAtomicSync } from '../durable-fs.js';
import {
  resolveServerBundlePath,
  SERVER_BUNDLE_SIDECAR_SUFFIX,
} from '../server-bundle-store.js';

const MARKER_SUFFIX = '.restore-server-bundle-swap.json';
const MARKER_VERSION = 2;
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export interface BundleSwapMarker {
  /** v1 markers predate config participation and remain readable so an update
   *  can recover a restore interrupted on the previous server version. */
  v: 1 | 2;
  staging_name: string;
  stamp: string;
  has_next_bundle: boolean;
  had_db: boolean;
  had_wal: boolean;
  had_shm: boolean;
  had_bundle: boolean;
  /** v2: config is committed in the same direction as the database. The path
   *  itself is never persisted; boot supplies its expected path and the marker
   *  binds that path by hash, preserving the no-arbitrary-path journal rule. */
  config?: {
    path_sha256: string;
    next_sha256: string;
    previous_sha256?: string;
    had_config: boolean;
  };
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
  readonly configPath: string | null;
  readonly stagedConfigPath: string | null;
  readonly configBackupPath: string | null;
  readonly marker: BundleSwapMarker;
}

export interface ServerBundleSwapCommitResult {
  readonly dbBackupPath: string | null;
  readonly configBackupPath: string | null;
  readonly configWritten: boolean;
  readonly backups: string[];
}

/** Durable/mutation boundaries exposed for observability and subprocess fault
 *  injection. Production callers omit the observer; tests terminate a child at
 *  one named boundary and let a fresh process drive normal reconciliation. */
export type ServerBundleSwapTransition =
  | 'next_bundle_staged'
  | 'next_config_staged'
  | 'swap_marker_published'
  | 'old_config_backed_up'
  | 'old_db_parked'
  | 'old_wal_parked'
  | 'old_shm_parked'
  | 'old_bundle_parked'
  | 'old_artifacts_fsynced'
  | 'new_db_published'
  | 'new_db_fsynced'
  | 'new_config_published'
  | 'new_bundle_published'
  | 'swap_renames_fsynced'
  | 'parks_resolved'
  | 'swap_marker_retired';

export interface ServerBundleSwapObserver {
  onTransition?: (transition: ServerBundleSwapTransition) => void;
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

const retireMarker = (tx: PreparedServerBundleSwap): void => {
  unlinkSync(tx.markerPath);
  // Marker absence is itself the durable "nothing left to replay" state.
  // Flushing only before unlink can resurrect the marker after power loss and
  // make a settled transaction look live again on the next boot.
  fsyncDir(dirname(tx.markerPath));
};

const markerBytes = (marker: BundleSwapMarker): Buffer =>
  Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

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
  const validConfig = marker.config === undefined || (
    marker.v === 2
    && typeof marker.config === 'object'
    && marker.config !== null
    && /^[0-9a-f]{64}$/.test(marker.config.path_sha256)
    && /^[0-9a-f]{64}$/.test(marker.config.next_sha256)
    && isBoolean(marker.config.had_config)
    && (marker.config.had_config
      ? typeof marker.config.previous_sha256 === 'string'
        && /^[0-9a-f]{64}$/.test(marker.config.previous_sha256)
      : marker.config.previous_sha256 === undefined)
  );
  if (
    (marker.v !== 1 && marker.v !== MARKER_VERSION)
    || (marker.v === 1 && marker.config !== undefined)
    || typeof marker.staging_name !== 'string'
    || (!onlineName.test(marker.staging_name) && !offlineName.test(marker.staging_name))
    || !validStamp
    || !isBoolean(marker.has_next_bundle)
    || !isBoolean(marker.had_db)
    || !isBoolean(marker.had_wal)
    || !isBoolean(marker.had_shm)
    || !isBoolean(marker.had_bundle)
    || !validConfig
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
  configPathInput?: string | null,
): PreparedServerBundleSwap => {
  const dbPath = resolve(dbPathInput);
  const stagingDbPath = join(dirname(dbPath), marker.staging_name);
  const bundlePath = resolveServerBundlePath(dbPath);
  let configPath: string | null = null;
  let stagedConfigPath: string | null = null;
  let configBackupPath: string | null = null;
  if (marker.config) {
    if (!configPathInput) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_CONFIG_PATH_MISSING: marker for ${dbPath} requires its config path`,
      );
    }
    configPath = resolve(configPathInput);
    if (sha256(configPath) !== marker.config.path_sha256) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_CONFIG_PATH_CHANGED: supplied config path does not match the marker for ${dbPath}`,
      );
    }
    stagedConfigPath = `${configPath}.restore-${marker.stamp}.tmp`;
    configBackupPath = `${configPath}.bak-${marker.stamp}`;
  }
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
    configPath,
    stagedConfigPath,
    configBackupPath,
    marker,
  };
};

const readTransaction = (
  dbPath: string,
  configPath?: string | null,
): PreparedServerBundleSwap | null => {
  const resolvedDbPath = resolve(dbPath);
  const markerPath = resolveServerBundleSwapMarkerPath(resolvedDbPath);
  if (!existsSync(markerPath)) return null;
  const marker = parseMarker(resolvedDbPath, readFileSync(markerPath, 'utf8'));
  return transactionFromMarker(resolvedDbPath, marker, configPath);
};

/** Reclaim whole-database restore staging that a hard kill left BEFORE the
 *  durable swap marker existed.
 *
 *  Both restore doors stream a complete database beside the live one first.
 *  Their ordinary catches remove it, but SIGKILL/OOM/power loss skips those
 *  catches. Before this sweep, a keyless realm therefore left a full plaintext
 *  database copy indefinitely, and every interrupted attempt leaked another.
 *
 *  A marker's named staging transaction is load-bearing: its presence selects
 *  rollback rather than forward completion. Preserve that transaction and only
 *  remove other names matching the exact nonce shapes this module accepts. The
 *  marker has already been reconciled at the boot call site, but it may remain
 *  deliberately when a CAS park could not be resolved. */
export const sweepOrphanedRestoreStaging = (
  dbPathInput: string,
  configPath?: string | null,
): number => {
  const dbPath = resolve(dbPathInput);
  const dir = dirname(dbPath);
  const activeTx = readTransaction(dbPath, configPath);
  const active = activeTx?.stagingDbPath;
  const dbName = basename(dbPath);
  const escapedDbName = dbName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const basePattern = `(?:${escapedDbName}\\.staging-[0-9a-f]{16}`
    + `|${escapedDbName}\\.restore-[0-9a-f]{16}\\.tmp)`;
  const artifactPattern = new RegExp(
    `^(${basePattern})(?:-wal|-shm|${SERVER_BUNDLE_SIDECAR_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?$`,
  );
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    const match = artifactPattern.exec(name);
    if (!match) continue;
    const transactionPath = join(dir, match[1]!);
    if (active && transactionPath === active) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      /* best effort; boot must not fail over inert scratch cleanup */
    }
  }
  if (removed > 0) fsyncDir(dir);

  // Config staging can live outside the data directory. The live config is
  // never moved before the database commit point, so an unjournaled stage is
  // inert scratch and safe to reap; a marker-owned stage must survive so
  // post-commit recovery can publish it.
  if (configPath) {
    const resolvedConfig = resolve(configPath);
    const configDir = dirname(resolvedConfig);
    const escapedConfigName = basename(resolvedConfig)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const configPattern = new RegExp(
      `^${escapedConfigName}\\.restore-`
        + `\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{8}\\.tmp$`,
    );
    let configNames: string[] = [];
    try { configNames = readdirSync(configDir); } catch { /* best effort */ }
    let configRemoved = 0;
    for (const name of configNames) {
      if (!configPattern.test(name)) continue;
      const path = join(configDir, name);
      if (activeTx?.stagedConfigPath === path) continue;
      try {
        unlinkSync(path);
        removed += 1;
        configRemoved += 1;
      } catch { /* inert scratch cleanup never blocks boot */ }
    }
    if (configRemoved > 0) fsyncDir(configDir);
  }
  return removed;
};

const sameTransaction = (
  expected: PreparedServerBundleSwap,
  actual: PreparedServerBundleSwap,
): boolean =>
  expected.dbPath === actual.dbPath
  && expected.stagingDbPath === actual.stagingDbPath
  && expected.configPath === actual.configPath
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
    ...(tx.marker.config?.had_config && tx.configBackupPath
      ? [tx.configBackupPath]
      : []),
  ]) {
    if (existsSync(path)) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_BACKUP_EXISTS: refusing to overwrite ${path}`,
      );
    }
  }
};

const requireConfigPaths = (tx: PreparedServerBundleSwap): {
  configPath: string;
  stagedConfigPath: string;
  configBackupPath: string;
} => {
  if (!tx.configPath || !tx.stagedConfigPath || !tx.configBackupPath) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_CONFIG_PATH_MISSING: config transaction paths are incomplete for ${tx.dbPath}`,
    );
  }
  return {
    configPath: tx.configPath,
    stagedConfigPath: tx.stagedConfigPath,
    configBackupPath: tx.configBackupPath,
  };
};

const hashFile = (path: string): string => sha256(readFileSync(path));

/** Complete config publication once the database commit point has landed. */
const settleConfigForward = (tx: PreparedServerBundleSwap): boolean => {
  const config = tx.marker.config;
  if (!config) return false;
  const { configPath, stagedConfigPath } = requireConfigPaths(tx);
  if (existsSync(stagedConfigPath)) {
    if (hashFile(stagedConfigPath) !== config.next_sha256) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: staged config changed for ${tx.dbPath}`,
      );
    }
    // Same-directory atomic replace: the old config stays readable until this
    // exact rename, and a retry can distinguish staged-vs-live by content hash.
    renameSync(stagedConfigPath, configPath);
    fsyncDir(dirname(configPath));
    return true;
  } else if (!existsSync(configPath) || hashFile(configPath) !== config.next_sha256) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: neither staged nor published config matches ${tx.dbPath}`,
    );
  }
  fsyncDir(dirname(configPath));
  return false;
};

/** Keep/restore the pre-restore config when the database commit point did not
 *  land. Commit copies (never moves) the old config, so the common crash path
 *  already has the right live file; the backup handles a concurrent loss. */
const settleConfigRollback = (tx: PreparedServerBundleSwap): boolean => {
  const config = tx.marker.config;
  if (!config) return false;
  const { configPath, configBackupPath } = requireConfigPaths(tx);
  if (config.had_config) {
    const liveIsOld = existsSync(configPath)
      && hashFile(configPath) === config.previous_sha256;
    if (!liveIsOld) {
      if (
        !existsSync(configBackupPath)
        || hashFile(configBackupPath) !== config.previous_sha256
      ) {
        throw new Error(
          `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: prior config is unavailable for ${tx.dbPath}`,
        );
      }
      writeFileAtomicSync(configPath, readFileSync(configBackupPath));
      return true;
    }
  } else if (existsSync(configPath)) {
    // This shape is reachable in direct/offline callers that explicitly name an
    // absent config path. Remove only the exact staged content; an unrelated file
    // appearing concurrently is ambiguous and must fail closed.
    if (hashFile(configPath) !== config.next_sha256) {
      throw new Error(
        `ARCHIVE_RESTORE_BUNDLE_SWAP_INCOMPLETE: unexpected config appeared for ${tx.dbPath}`,
      );
    }
    unlinkSync(configPath);
    fsyncDir(dirname(configPath));
    return true;
  }
  return false;
};

/** Settle only the config member of an interrupted restore before the config
 *  loader commits its in-memory boot snapshot. Full db/bundle/CAS reconciliation
 *  still runs at the pre-storage boundary; this early, idempotent projection
 *  prevents a crash after the database commit point from booting the new realm
 *  under the old config that was live one rename earlier. Returns whether the
 *  live config changed and the caller must load it again. */
export const reconcileServerBundleSwapConfigBeforeLoad = (
  dbPath: string,
  configPath: string | null,
): boolean => {
  const tx = readTransaction(dbPath, configPath);
  if (!tx?.marker.config) return false;
  return existsSync(tx.stagingDbPath)
    ? settleConfigRollback(tx)
    : settleConfigForward(tx);
};

export interface ServerBundleSwapReconcileOptions {
  configPath?: string | null;
}

/** Reconcile an interrupted db + bundle-sidecar swap before either is opened.
 *  `reclaimParks` resolves the restore's CAS parks under the verdict reached
 *  here, while the marker still exists — see the module header. */
export const reconcileServerBundleSwap = (
  dbPathInput: string,
  reclaimParks: ReclaimSwapParks,
  options: ServerBundleSwapReconcileOptions = {},
): ServerBundleSwapReconcileResult => {
  const tx = readTransaction(dbPathInput, options.configPath);
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
    settleConfigForward(tx);
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
    if (retired) retireMarker(tx);
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
  settleConfigRollback(tx);

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
  retireMarker(tx);
  for (const path of [
    tx.stagingDbPath,
    `${tx.stagingDbPath}-wal`,
    `${tx.stagingDbPath}-shm`,
    tx.stagedBundlePath,
    ...(tx.stagedConfigPath ? [tx.stagedConfigPath] : []),
  ]) {
    try { unlinkIfPresent(path); } catch { /* old live pair is already safe */ }
  }
  fsyncDir(dirname(tx.dbPath));
  if (tx.stagedConfigPath) fsyncDir(dirname(tx.stagedConfigPath));
  return { recovery: 'rolled_back', retired: true };
};

/** Stage the next bundle and durable marker before moving any live artifact. */
export const prepareServerBundleSwap = (args: {
  dbPath: string;
  stagingDbPath: string;
  stamp: string;
  nextBundle?: Buffer;
  configPath?: string | null;
  nextConfig?: Buffer;
  observer?: ServerBundleSwapObserver;
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

  const configPath = args.nextConfig !== undefined && args.configPath
    ? resolve(args.configPath)
    : null;
  const hadConfig = configPath ? existsSync(configPath) : false;
  const marker: BundleSwapMarker = {
    v: MARKER_VERSION,
    staging_name: basename(stagingDbPath),
    stamp: args.stamp,
    has_next_bundle: args.nextBundle !== undefined,
    had_db: existsSync(dbPath),
    had_wal: existsSync(`${dbPath}-wal`),
    had_shm: existsSync(`${dbPath}-shm`),
    had_bundle: existsSync(resolveServerBundlePath(dbPath)),
    ...(configPath && args.nextConfig !== undefined
      ? {
          config: {
            path_sha256: sha256(configPath),
            next_sha256: sha256(args.nextConfig),
            had_config: hadConfig,
            ...(hadConfig
              ? { previous_sha256: sha256(readFileSync(configPath)) }
              : {}),
          },
        }
      : {}),
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
  const tx = transactionFromMarker(
    dbPath,
    parseMarker(dbPath, JSON.stringify(marker)),
    configPath,
  );
  assertBackupTargetsFree(tx);
  if (existsSync(tx.stagedBundlePath)) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: staged bundle already exists at ${tx.stagedBundlePath}`,
    );
  }
  if (tx.stagedConfigPath && existsSync(tx.stagedConfigPath)) {
    throw new Error(
      `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: staged config already exists at ${tx.stagedConfigPath}`,
    );
  }

  try {
    if (tx.stagedConfigPath && args.nextConfig !== undefined) {
      writeFileAtomicSync(tx.stagedConfigPath, args.nextConfig);
      args.observer?.onTransition?.('next_config_staged');
    }
    if (args.nextBundle !== undefined) {
      writeFileAtomicSync(tx.stagedBundlePath, args.nextBundle);
      args.observer?.onTransition?.('next_bundle_staged');
    }
    writeFileAtomicSync(tx.markerPath, markerBytes(marker));
    args.observer?.onTransition?.('swap_marker_published');
  } catch (err) {
    try { unlinkIfPresent(tx.stagedBundlePath); } catch { /* best effort */ }
    if (tx.stagedConfigPath) {
      try { unlinkIfPresent(tx.stagedConfigPath); } catch { /* best effort */ }
    }
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
  observer: ServerBundleSwapObserver = {},
): ServerBundleSwapCommitResult => {
  const disk = readTransaction(prepared.dbPath, prepared.configPath);
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
    ...(tx.marker.config?.had_config && tx.configBackupPath
      ? [tx.configBackupPath]
      : []),
  ];
  const result: ServerBundleSwapCommitResult = {
    dbBackupPath: tx.marker.had_db ? tx.dbBackupPath : null,
    configBackupPath: tx.marker.config?.had_config
      ? tx.configBackupPath
      : null,
    configWritten: tx.marker.config !== undefined,
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
    if (tx.marker.config) {
      const { configPath: liveConfig, stagedConfigPath, configBackupPath } = requireConfigPaths(tx);
      assertPathState(liveConfig, tx.marker.config.had_config, 'live config');
      assertPathState(stagedConfigPath, true, 'staged config');
      assertPathState(configBackupPath, false, 'config backup');
      if (hashFile(stagedConfigPath) !== tx.marker.config.next_sha256) {
        throw new Error(
          `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: staged config changed for ${tx.dbPath}`,
        );
      }
      if (tx.marker.config.had_config) {
        if (hashFile(liveConfig) !== tx.marker.config.previous_sha256) {
          throw new Error(
            `ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: live config changed after restore staging for ${tx.dbPath}`,
          );
        }
        writeFileAtomicSync(configBackupPath, readFileSync(liveConfig));
        observer.onTransition?.('old_config_backed_up');
      }
    }

    if (tx.marker.had_db) {
      renameSync(tx.dbPath, tx.dbBackupPath);
      observer.onTransition?.('old_db_parked');
    }
    if (tx.marker.had_wal) {
      renameSync(`${tx.dbPath}-wal`, tx.walBackupPath);
      observer.onTransition?.('old_wal_parked');
    }
    if (tx.marker.had_shm) {
      renameSync(`${tx.dbPath}-shm`, tx.shmBackupPath);
      observer.onTransition?.('old_shm_parked');
    }
    if (tx.marker.had_bundle) {
      renameSync(tx.bundlePath, tx.bundleBackupPath);
      observer.onTransition?.('old_bundle_parked');
    }

    // Make the rollback set durable before publishing the replacement db. If
    // power fails around the next rename, the marker can then decide from the
    // atomic presence of `stagingDbPath`: present rolls back to this fsynced
    // set; absent completes forward from the newly published database.
    fsyncDir(dirname(tx.dbPath));
    observer.onTransition?.('old_artifacts_fsynced');

    // Commit point: after this rename, crash recovery completes FORWARD.
    renameSync(tx.stagingDbPath, tx.dbPath);
    observer.onTransition?.('new_db_published');
    // Persist the commit verdict itself before publishing members that may live
    // on another filesystem. Without this barrier a power loss could preserve
    // new config while losing the db rename that made it authoritative.
    fsyncDir(dirname(tx.dbPath));
    observer.onTransition?.('new_db_fsynced');
    if (tx.marker.config) {
      const { configPath: liveConfig, stagedConfigPath } = requireConfigPaths(tx);
      renameSync(stagedConfigPath, liveConfig);
      fsyncDir(dirname(liveConfig));
      observer.onTransition?.('new_config_published');
    }
    if (tx.marker.has_next_bundle) {
      renameSync(tx.stagedBundlePath, tx.bundlePath);
      observer.onTransition?.('new_bundle_published');
    }
    // Flush the matching bundle publication before the marker goes away. The
    // db commit point and any cross-directory config rename were each flushed
    // at their own phase boundary above.
    fsyncDir(dirname(tx.dbPath));
    observer.onTransition?.('swap_renames_fsynced');
    // The archive's blobs are authoritative from the commit point above, so the
    // parked originals are dead weight — but ONLY this marker still knows that.
    // Reaping them after releasing it left a window where a kill in between
    // produced "parks present, no marker", which boot reads as an uncommitted
    // restore and rolls the PRE-restore bytes back over the objects the new
    // database references. Inside the journal, a kill here simply leaves the
    // marker for boot to reconcile forward.
    if (reclaimParks(true)) {
      observer.onTransition?.('parks_resolved');
      retireMarker(tx);
      observer.onTransition?.('swap_marker_retired');
    }
  } catch (err) {
    let recovery: ServerBundleSwapReconcileResult;
    try {
      // Pre-commit failures roll back; post-commit failures finish forward.
      // Same park list either way — this is OUR transaction, so its verdict is
      // exactly the one those parks are waiting on.
      recovery = reconcileServerBundleSwap(tx.dbPath, reclaimParks, {
        configPath: tx.configPath,
      });
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
