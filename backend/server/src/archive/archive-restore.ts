/** Phase F (D-108) — archive restore (write-into-`data_path`).
 *
 *  The inverse-of-the-inverse: `streamImportArchive` decrypts + verifies an
 *  archive; this module DRIVES it, writing the decrypted records straight
 *  into a live `data_path` so the server can boot on them.
 *
 *  M4b.0 streaming rework: restore no longer materializes the whole archive
 *  (`ImportedRecords` with a multi-GB `db: Buffer` + every blob in RAM).
 *  Both entry points feed `streamImportArchive` a consumer that streams the
 *  db record to a target file as it's decrypted (`makeFileSink`) and
 *  overlays each blob into the CAS one at a time. M-blob: each blob now
 *  STREAMS to a temp file then content-addresses into the CAS via
 *  `putFile` (`overlaySingleBlobFile`), so a GB-scale attachment never lands
 *  in RAM either — only the KB-scale config record is buffered. Peak is now
 *  one read chunk, no longer the largest single blob.
 *
 *  Two callers:
 *    - OFFLINE (`applyRestore`, the `archive` CLI): the server is
 *      STOPPED. The db file is not open, so the commit is a single
 *      temp-file + atomic rename onto `dbPath`.
 *    - ONLINE (`stageRestore` + `commitStagedRestore`, the
 *      `server.archive.import` rpc): the server is LIVE. It cannot swap
 *      an *open* SQLite db, so the heavy write is STAGED beside the live
 *      db (`dbPath.staging-<nonce>`, unique per import) while the server keeps
 *      serving, then the drain closes the db and `commitStagedRestore` does the fast
 *      rename-swap. `stageRestore` returns a SMALL `StagedRestore`
 *      descriptor (config + counts, no db bytes) so nothing GB-sized sits
 *      resident across the drain. See `archive-runtime.ts` for the
 *      orchestration.
 *
 *  Safety contract (restore CLOBBERS user data, so every step is made
 *  reversible / fail-safe):
 *    1. (offline only) Refuse if a live server holds the instance lock.
 *    2. Write blobs FIRST — content-addressed + additive, so the db only
 *       references bytes that already exist on disk. The db streams to a
 *       SIDE path (temp / staging), never to `dbPath`, during this phase.
 *    3. Stage config beside its live path; keep the old config readable until
 *       the database commit point decides which version wins.
 *    4. Stage the archive's D-212 bundle sidecar + a same-dir swap marker,
 *       then move the existing db, WAL/SHM, and bundle to backup paths.
 *    5. Rename the verified temp/staging db onto `dbPath` — the commit point —
 *       then publish its matching config + bundle and clear the marker. If the
 *       process dies in that multi-file window, the next boot deterministically
 *       rolls back while the staged db remains or completes forward once it does not.
 *       A wrong key / tamper aborts before this swap, leaving at most harmless
 *       content-addressed CAS orphans the sweep reaps.
 *
 *  This is SAFETY, not migration: we write the archive's db verbatim. If
 *  it carries an older schema, the server's boot-time migration handles
 *  it — restore adds no migration logic.
 */

import {
  copyFileSync,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import {
  bundleFromJSON,
  serverBundleFromJSON,
  openBundleWithRecoveryEntropy,
  openServerBundleWithRecoveryEntropy,
  deriveSubDEK,
  serverBundleToJSON,
  type ServerBundle,
} from '@recued/crypto';
import {
  createEncryptedBlobStore,
  resolveBlobObjectPath,
  DISPLACED_BLOB_SUFFIX,
  type BlobStore,
} from '../storage/blob-store.js';
import {
  deriveDatabaseKeyFromRecoveryEntropy,
  rebindServerBundleForLocalBoot,
} from '../database-encryption.js';
import { createInstanceLock } from '../lifecycle/instance-lock.js';
import { openDatabase } from '../open-database.js';
import { FILE_NAMES, type ArchiveManifest } from './archive-format.js';
import {
  DISCARD_RECORD_WRITER,
  streamImportArchive,
  type BlobNamespace,
  type ImportConsumer,
  type ImportOptions,
  type RecordWriter,
} from './archive-import.js';
import { stageRestoreProvenanceMarker } from './restore-provenance.js';
import { restoreBlobScratchPath } from './archive-scratch.js';
import { fsyncDir, fsyncFile } from '../durable-fs.js';
import { resolveServerBundlePath } from '../server-bundle-store.js';
import {
  commitPreparedServerBundleSwap,
  prepareServerBundleSwap,
  reconcileServerBundleSwap,
  resolveServerBundleSwapMarkerPath,
} from './server-bundle-swap.js';

/** Lock file the running daemon holds — see `instance-lock.ts`. The
 *  restore guard reads it to decide whether a server is live. */
const SERVER_LOCK_FILE = 'recued-server.lock';

/** SQLite WAL-mode sidecars. They belong to the *outgoing* db; a clean
 *  restored db has neither, so we move them out of the way too — a stale
 *  `-wal` adjacent to the new db file silently corrupts it on first open. */
const WAL_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/** Suffix appended to `dbPath` for the online staged db. The heavy
 *  whole-db write lands here while the live server keeps serving from
 *  the old db; the commit renames it onto `dbPath`. */
const STAGING_SUFFIX = '.staging';

export interface RestoreTargets {
  /** Absolute path of the SQLite db file to (re)write. */
  dbPath: string;
  /** `dirname(dbPath)` — the server data directory (blobs/, lock live here). */
  dataPath: string;
  /** Config file path, or null when config came from env/defaults (no
   *  file on disk). When null we cannot know where to write the archive's
   *  config, so we skip it. */
  configPath: string | null;
}

export interface ApplyRestoreOptions {
  /** Proceed even when a live server holds the instance lock. The
   *  operator's explicit "I know it's running / the lock is wrong"
   *  override. Forcing a restore over a genuinely-live engine risks
   *  corruption — the caller owns that decision. */
  force?: boolean;
  /** Liveness probe for the running-server guard. Injected for tests so
   *  a fake lock file can simulate a live (or dead) holder. Defaults to
   *  a `process.kill(pid, 0)` check. */
  isProcessAlive?: (pid: number) => boolean;
  /** Clock for backup-file stamping + the returned `restored_at`.
   *  Injected for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RestoreResult {
  /** Unix-ms the restore completed. */
  restored_at: number;
  /** Bytes of the authenticated database image restored from the archive.
   *  Enrolled realms remain full-file encrypted inside that archive record. */
  db_bytes: number;
  /** Number of blobs written (overlay — dedup-safe). */
  blob_count: number;
  /** Whether the archive's config was written (false when absent or no
   *  known config path). */
  config_written: boolean;
  /** Where the prior db was moved, or null when there was none. */
  db_backup_path: string | null;
  /** Every backup file produced (db + sidecars + config), for the report
   *  + manual rollback. */
  backups: string[];
}

/** The small handoff from `stageRestore` to `commitStagedRestore`. The db
 *  itself already sits at `stagingPath` on disk; only the KB-scale config +
 *  the report counters + the manifest ride in memory across the drain (NOT
 *  the db bytes — that was the resident-multi-GB-across-restart cost the
 *  streaming rework removes). */
export interface StagedRestore {
  /** Where `stageRestore` wrote the authenticated database image. */
  stagingPath: string;
  /** Blobs overlaid into the CAS. */
  blob_count: number;
  /** Restored database-image byte count (for the result report). */
  db_bytes: number;
  /** The archive's config record, when present + a config path is known. */
  config?: Buffer;
  /** D-212 dual-wrapped Master-DEK sidecar from the archive. Undefined means
   *  the restored realm is keyless/legacy and any current sidecar is removed. */
  serverVaultBundle?: Buffer;
  /** The on-disk archive manifest (for the wire-manifest mapping). */
  manifest: ArchiveManifest;
  /** Whether the archive embedded a `passport.json`. */
  passportPresent: boolean;
  /** The archive's embedded `passport.json` bytes (a signed `migration_full`
   *  projection) when present — staged into a `dataPath` marker at commit so
   *  the post-restart boot can record the migration provenance (M5 S1). The
   *  KB-scale record is already buffered whole by the importer. */
  passportBytes?: Buffer;
  /** Live CAS objects the overlay wrote over, parked so a discard can undo it.
   *  Blobs land in the live CAS during staging but the db swap happens after
   *  the drain, so a drain that fails leaves the OLD database in place still
   *  referencing them. Reaped at commit, rolled back at discard. */
  displacedBlobs?: DisplacedBlob[];
}

/** Default liveness probe. A bare `process.kill(pid, 0)` throws ESRCH
 *  when the process is gone and EPERM when it exists but we can't signal
 *  it — the latter still means "alive", so the guard must treat EPERM as
 *  alive (fail safe: don't clobber a server we merely can't signal). */
const defaultIsProcessAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Filesystem-safe stamp for `.bak-<stamp>` suffixes (no `:` / `.`). */
const backupStamp = (ms: number): string =>
  new Date(ms).toISOString().replace(/[:.]/g, '-');

/** Collision-resistant `.bak-<stamp>` token. The ms timestamp alone
 *  repeats across back-to-back restores (and is fully fixed under an
 *  injected clock), so a random suffix guarantees a fresh restore never
 *  silently clobbers an earlier backup — the .bak set is the rollback
 *  safety net. */
const makeBackupStamp = (ms: number): string =>
  `${backupStamp(ms)}-${randomBytes(4).toString('hex')}`;

/** A UNIQUE online staged-db path for ONE restore. A per-import nonce makes
 *  concurrent stages collision-proof: two imports never write the same staging
 *  file, so a still-pending commit can't pick up a LATER import's bytes — the
 *  fixed-path clobber that let a drain commit the WRONG db (the import-latch
 *  race). The committer + discarder use the path carried on the `StagedRestore`
 *  descriptor, never recompute it. */
export const uniqueStagingDbPath = (dbPath: string): string =>
  `${dbPath}${STAGING_SUFFIX}-${randomBytes(8).toString('hex')}`;

/** A streaming `RecordWriter` that lands plaintext at `destPath`, with
 *  backpressure (each `write` awaits the chunk's flush) + an explicit
 *  `destroy` for the abort path. The same-dir caller renames it into place
 *  after the whole stream verifies, so a torn write never reaches `dbPath`. */
interface FileSink extends RecordWriter {
  destroy(): void;
}

const makeFileSink = (destPath: string, opts: { durable?: boolean } = {}): FileSink => {
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Owner-only from creation, not after: these files hold decrypted warehouse
  // bytes, and the data dir is not itself 0700, so a default-mode create would
  // publish plaintext world-readable for the life of the write. Matches the
  // 0600 discipline the keyfile / bundle / marker writers already keep.
  const ws = createWriteStream(destPath, { mode: 0o600 });
  // Capture an async stream error so a later write/end rejects with it
  // rather than leaving an unhandled 'error' event to crash the process.
  let sawError: Error | undefined;
  ws.once('error', (e) => { sawError = e as Error; });
  return {
    write: (chunk) => new Promise<void>((resolve, reject) => {
      if (sawError) { reject(sawError); return; }
      ws.write(chunk, (err) => (err ? reject(err) : resolve()));
    }),
    end: async () => {
      if (sawError) throw sawError;
      ws.end();
      await finished(ws);
      // The staged db is about to become the live one by rename, so its bytes
      // must be durable BEFORE the swap — a stream close only hands them to the
      // page cache. Skipped for per-blob scratch, which is transient by design.
      if (opts.durable) fsyncFile(destPath);
    },
    destroy: () => { ws.destroy(); },
  };
};

/** Overlay ONE blob into the CAS via a target store, content-addressed +
 *  STREAMING (peak = one chunk, never the whole blob in RAM — the M-blob win).
 *  Production restore routes every namespace to an encrypted target, including
 *  the historical `blobs/` namespace. The archive carries PLAINTEXT (Phase 2),
 *  so `putFile` content-addresses over the plaintext temp — computing `hash` =
 *  sha256(plaintext) — and re-encrypts under the restored realm's blob key;
 *  `written === hash` therefore holds across every root. Throws
 *  `ARCHIVE_RESTORE_BLOB_HASH_MISMATCH` if the bytes don't content-address to
 *  `hash`. */
/** A live CAS object this restore displaced, and where its original bytes
 *  were parked. Rolled back on abort, reaped at commit. */
export interface DisplacedBlob {
  /** The CAS object path the archive's version was written over. */
  objectPath: string;
  /** The parked original — a hard link to the pre-restore inode. */
  asidePath: string;
}

/** Park the live object at `objectPath` so an aborted restore can put it
 *  back. A hard link, not a copy: it costs one directory entry regardless of
 *  blob size, and `putFile`'s atomic rename then replaces the ORIGINAL entry
 *  while this one keeps pointing at the pre-restore inode. Returns null when
 *  there is nothing live to displace (the common case — a new object). */
/** Monotonic within a process, so a park's NAME carries the order it was made
 *  in. In-process the order is the array; after a kill, `reclaimDisplacedBlobs`
 *  has only the filenames to reconstruct it from, and picking the wrong one of
 *  two parks for the same object reinstates an intermediate rather than the
 *  true pre-restore original. A random suffix alone left that to readdir order. */
let displacedBlobSequence = 0;

const parkDisplacedBlob = (objectPath: string): DisplacedBlob | null => {
  if (!existsSync(objectPath)) return null;
  // Zero-padded so lexicographic order IS park order, plus randomness so two
  // processes cannot collide on a name.
  const seq = String(displacedBlobSequence++).padStart(9, '0');
  const asidePath = `${objectPath}${DISPLACED_BLOB_SUFFIX}${seq}-${randomBytes(6).toString('hex')}`;
  try {
    linkSync(objectPath, asidePath);
  } catch {
    // Exotic filesystem without hard links — fall back to a copy rather than
    // proceeding unprotected. A failure HERE must abort the overlay: writing
    // over a live object we cannot restore is the whole hazard.
    copyFileSync(objectPath, asidePath);
  }
  // The park must be DURABLE before the caller overwrites the object it aliases:
  // the ordering is the rollback guarantee. Without this barrier, power loss
  // could persist the overlay's overwrite while the park link is still in page
  // cache — leaving the surviving old database referencing bytes no park can
  // put back. Same best-effort `fsyncDir` the swap journal + boot reclaim use.
  fsyncDir(dirname(objectPath));
  return { objectPath, asidePath };
};

/** Put a parked original back. Used on abort, where the archive's version
 *  must not survive because the OLD database does.
 *
 *  Parks against one object path form a STACK: a second overlay of the same
 *  hash parks what the FIRST overlay wrote, not the pre-restore original. Only
 *  the OLDEST is the true original; the rest are intermediate bytes the restore
 *  itself produced. */
/** Which of an object's parks holds the TRUE pre-restore original.
 *
 *  The oldest one. Park names carry a zero-padded sequence precisely so this
 *  survives a kill, when filenames are all that is left. Directory order is not
 *  a contract — and on the filesystems where it happens to come back sorted it
 *  merely hides the bug. Pure + exported so the ordering can be proven without
 *  depending on what `readdir` chooses to return. */
export const selectParkToRestore = (parkFilenames: readonly string[]): string | undefined =>
  [...parkFilenames].sort()[0];

/** Resolve ONE object's stack of parks, preserving the invariant every reader
 *  downstream depends on: after this returns, the OLDEST surviving park (if
 *  any) is still the true pre-restore original.
 *
 *  ⛔ ORDER IS THE INVARIANT on rollback (`committed=false`). Discard the
 *  intermediates FIRST; restore the original ONLY once every intermediate is
 *  cleared. Consuming the original while an intermediate survives leaves that
 *  intermediate as the oldest survivor — and `reclaimDisplacedBlobs` on the
 *  next boot, which picks the oldest survivor, would then restore that
 *  intermediate over the live object. Leaving the original in place on a partial
 *  failure lets the retry find it. (Committed: every park is dead weight, so
 *  order is irrelevant — all are discarded.) */
const resolveObjectParkStack = (
  objectPath: string,
  asidePaths: readonly string[],
  committed: boolean,
): { restored: number; reaped: number; complete: boolean; touched: boolean } => {
  let restored = 0;
  let reaped = 0;
  let complete = true;
  let touched = false;
  const discard = (aside: string): boolean => {
    try {
      if (existsSync(aside)) { unlinkSync(aside); reaped += 1; touched = true; }
      return true;
    } catch { complete = false; return false; }
  };

  if (committed) {
    for (const aside of asidePaths) discard(aside);
    return { restored, reaped, complete, touched };
  }

  const original = selectParkToRestore(asidePaths);
  let intermediatesCleared = true;
  for (const aside of asidePaths) {
    if (aside === original) continue;
    if (!discard(aside)) intermediatesCleared = false;
  }
  // Restore the original only when nothing intermediate can outlive it; else
  // leave it on disk (the `.pre-restore-` suffix the CAS sweep never reaps) so
  // the retry — reporting `false` keeps the journal — puts it back.
  if (original === undefined || !intermediatesCleared) {
    if (original !== undefined) complete = false;
    return { restored, reaped, complete, touched };
  }
  try {
    if (existsSync(original)) { renameSync(original, objectPath); restored += 1; touched = true; }
  } catch { complete = false; }
  return { restored, reaped, complete, touched };
};

/** Put the parked originals back on abort. Groups by object and defers to
 *  `resolveObjectParkStack`, so a stack with a stranded intermediate never
 *  consumes its true original — the partial-failure hazard a flat reversed
 *  rename had. Returns whether EVERY park was resolved: the swap journal
 *  releases its marker on that answer, so a park stranded with the marker
 *  already gone is read by the next boot as an uncommitted restore. */
export const rollBackDisplacedBlobs = (displaced: readonly DisplacedBlob[]): boolean => {
  const byObject = new Map<string, string[]>();
  for (const { objectPath, asidePath } of displaced) {
    const group = byObject.get(objectPath);
    if (group) group.push(asidePath);
    else byObject.set(objectPath, [asidePath]);
  }
  let complete = true;
  const touchedDirs = new Set<string>();
  for (const [objectPath, asidePaths] of byObject) {
    const r = resolveObjectParkStack(objectPath, asidePaths, false);
    if (!r.complete) complete = false;
    if (r.touched) touchedDirs.add(dirname(objectPath));
  }
  // This runs inside the swap journal's `reclaimParks(false)` callback, right
  // before the marker is released — so the restored originals have to be as
  // durable as the marker's own realm-dir fsync, or power loss could clear the
  // marker while the rollback is still in page cache.
  for (const dir of touchedDirs) fsyncDir(dir);
  return complete;
};

/** Drop the parked originals once the restore has committed and the archive's
 *  versions are authoritative. Reports completeness for the same reason
 *  `rollBackDisplacedBlobs` does. */
export const reapDisplacedBlobs = (displaced: readonly DisplacedBlob[]): boolean => {
  let complete = true;
  const touchedDirs = new Set<string>();
  for (const { asidePath } of displaced) {
    try {
      if (existsSync(asidePath)) {
        unlinkSync(asidePath);
        touchedDirs.add(dirname(asidePath));
      }
    } catch { complete = false; }
  }
  // Reap runs inside `reclaimParks(true)` just before the marker release, so the
  // removals must be durable before the marker is gone — otherwise power loss
  // could resurrect a park under a marker that already said "committed", and the
  // next boot would read that stray park as an uncommitted restore.
  for (const dir of touchedDirs) fsyncDir(dir);
  return complete;
};

/** Boot-time reclaim of parks left by a restore that was killed between the
 *  overlay and its commit-or-abort.
 *
 *  This is the only safe place to decide their fate. In-process, a park's
 *  outcome is known from the restore's own control flow; after a kill it is
 *  known only from the swap journal, which `reconcileServerBundleSwap` has
 *  just resolved:
 *
 *    - `committed` — the archive's database is now live, so its blobs are the
 *      correct ones and the parked originals are dead weight.
 *    - anything else — the swap did not land, the OLD database is still
 *      serving, and it references the parked bytes. Put them back.
 *
 *  The CAS sweep deliberately leaves parks alone (an age gate cannot work: a
 *  hard link inherits its target's mtime), so unreclaimed parks would
 *  otherwise accumulate forever. Best-effort throughout — a park we cannot
 *  move is not a reason to fail a boot. */
export const reclaimDisplacedBlobs = (
  dataPath: string,
  committed: boolean,
): { restored: number; reaped: number; complete: boolean } => {
  let restored = 0;
  let reaped = 0;
  // Whether every park found was resolved. The swap journal gates its marker
  // release on this — see `server-bundle-swap`. A park left behind while the
  // marker goes is exactly the state boot cannot interpret.
  let complete = true;
  for (const root of ['blobs', 'cache_blobs', 'memory_blobs']) {
    const objectsDir = join(dataPath, root, 'objects');
    // A genuinely ABSENT objects tree has nothing to reclaim — leave `complete`
    // true. But an objects tree that EXISTS and cannot be read is a subtree we
    // could not inspect: any park hiding in it stays unresolved, so the journal
    // must be KEPT (complete=false), exactly as a per-park move failure does.
    // Skipping it silently while reporting success stranded parks with no
    // marker left to decide their fate.
    if (!existsSync(objectsDir)) continue;
    let shards: string[];
    try { shards = readdirSync(objectsDir); } catch { complete = false; continue; }
    for (const shard of shards) {
      const shardDir = join(objectsDir, shard);
      let files: string[];
      try { files = readdirSync(shardDir); } catch { complete = false; continue; }
      // Group by the object each park belongs to. One object can carry more
      // than one park (a malformed archive repeating a blob record), and only
      // the OLDEST is the true pre-restore original — the rest are versions the
      // restore itself wrote. Park names are sequence-prefixed for exactly this
      // reason, so sorting them recovers the order after a kill.
      const parksByObject = new Map<string, string[]>();
      for (const file of files) {
        const idx = file.indexOf(DISPLACED_BLOB_SUFFIX);
        if (idx < 0) continue;
        const target = file.slice(0, idx);
        const group = parksByObject.get(target);
        if (group) group.push(file);
        else parksByObject.set(target, [file]);
      }
      let shardTouched = false;
      for (const [target, parks] of parksByObject) {
        // Same per-object discipline as the in-process rollback: discard the
        // intermediates first, restore the oldest ONLY if they all cleared. A
        // park we cannot move is not a boot failure — but it IS a reason to keep
        // the journal, so the next boot gets to decide it again.
        const objectPath = join(shardDir, target);
        const asidePaths = parks.map((file) => join(shardDir, file));
        const r = resolveObjectParkStack(objectPath, asidePaths, committed);
        restored += r.restored;
        reaped += r.reaped;
        if (!r.complete) complete = false;
        if (r.touched) shardTouched = true;
      }
      // The swap journal releases its marker on the strength of this call, so
      // the directory entries it changed have to be as durable as the renames
      // the marker's other steps make. Best-effort by construction (`fsyncDir`
      // swallows on platforms that cannot open a directory), which is the same
      // reach the rest of the journal has.
      if (shardTouched) fsyncDir(shardDir);
    }
  }
  return { restored, reaped, complete };
};

export const overlaySingleBlobFile = async (
  blobStore: BlobStore,
  hash: string,
  srcPath: string,
  /** CAS root + collector. When supplied, a live object at this hash is
   *  parked before it is overwritten so an abort can undo the overlay. */
  displace?: { root: string; into: DisplacedBlob[] },
): Promise<void> => {
  // Defense in depth: the blob name was already format-checked at the parser,
  // but this function is exported + `delete` builds the CAS path from raw hash
  // slices, so refuse anything that isn't a bare sha256 hex hash BEFORE any
  // filesystem op — a `../`-laden name must never reach the disk.
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(
      `ARCHIVE_RESTORE_BLOB_HASH_MISMATCH: blob name '${hash}' is not a 64-char hex content hash`,
    );
  }
  if (!blobStore.putFile) {
    throw new Error(
      'ARCHIVE_RESTORE_BLOB_STREAM_UNSUPPORTED: blob store lacks putFile (streaming write required for restore)',
    );
  }
  // Restore is AUTHORITATIVE: `putFile({replace})` re-publishes the archive's
  // bytes via temp → atomic rename, OVERWRITING a possibly torn / bit-rotted
  // object at the hash path — but WITHOUT a delete-before-write window. The
  // existing blob (which the CURRENT db may still reference, since blobs are
  // overlaid into the live CAS before the db swap) survives until the instant
  // of the rename; any failure before it (ENOSPC / unreadable source / crash)
  // leaves the old blob intact, so an aborted restore never strands a dangling
  // reference. `putFile` streams the source (peak = one chunk) + returns the
  // content hash it stored; the importer already AEAD-verified these bytes, so
  // a mismatch means the archive's blob name lied — refuse.
  //
  // "The old blob intact" holds only while both versions are readable by the
  // same realm. A CAS path is the PLAINTEXT hash, so identical content in two
  // realms collides — and a cross-realm restore (a supported, authorized flow)
  // rewrites that object under the ARCHIVE's key. If the drain then aborts,
  // the OLD database survives still referencing an object only the foreign key
  // opens. Park the live version first so the abort can put it back; the empty
  // blob alone guarantees a collision on any pair of realms.
  const objectPath = displace ? resolveBlobObjectPath(displace.root, hash) : null;
  const parked = objectPath ? parkDisplacedBlob(objectPath) : null;
  if (parked) displace!.into.push(parked);
  const written = await blobStore.putFile(srcPath, { replace: true });
  if (written !== hash) {
    throw new Error(
      `ARCHIVE_RESTORE_BLOB_HASH_MISMATCH: blob named ${hash} content-addressed to ${written}`,
    );
  }
  // The overlay must be DURABLE before the swap commits: once the new database
  // is live it references this object by hash, so a power loss that kept the
  // committed marker but lost the object rename would dangle that reference.
  // `putFile` publishes via atomic rename but does not fsync (it is the general
  // hot path); restore adds the barrier here. Best-effort, like the rest.
  if (objectPath) fsyncDir(dirname(objectPath));
};

/** Blob-encryption fix + D-212 — derive the realm's `blob-store` sub-DEK from
 *  the SERVER bundle sidecar, or the legacy password bundle in SQLite as a
 *  fallback. A wrong recovery key throws (GCM tag). Returns null only for a
 *  genuinely keyless realm.
 *
 *  FAIL-CLOSED on a corrupt read: only a genuinely-absent `server_config` table
 *  (older schema) maps to "keyless" — probed via the schema catalog, which never
 *  throws. A real read error (a corrupt / unreadable db on an ENCRYPTED realm) is
 *  therefore NOT swallowed into a false "keyless" that would archive ciphertext;
 *  it propagates so the caller refuses (export) / aborts before the swap (restore).
 *
 *  SHARED by two callers so both sides use the IDENTICAL derivation — the
 *  offline export decrypts each blob under exactly the key the restore
 *  re-encrypts it under:
 *    - restore (`deriveRestoreBlobKey`) — sidecar record + staged db legacy
 *      fallback from the archive being restored.
 *    - offline export (`cmdExport`) — live sidecar + live db legacy fallback. */
export const deriveBlobStoreKey = async (args: {
  db: Database.Database;
  serverBundle: ServerBundle | null;
  recoveryEntropy: Uint8Array;
}): Promise<Uint8Array | null> => {
  if (args.serverBundle) {
    const masterDEK = await openServerBundleWithRecoveryEntropy(
      args.serverBundle,
      args.recoveryEntropy,
    );
    try {
      return deriveSubDEK(masterDEK, 'blob-store');
    } finally {
      masterDEK.fill(0);
    }
  }

  // Legacy realm fallback. Probe the schema catalog (never throws on a missing
  // table) so a real read error is not swallowed into a false "keyless".
  const { db } = args;
  const hasServerConfig = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'server_config'`)
    .get() !== undefined;
  if (!hasServerConfig) return null;
  const readConfig = (key: string): string | null => {
    const row = db
      .prepare(`SELECT value FROM server_config WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  };
  const legacyJson = readConfig('bundle');
  if (legacyJson) {
    const masterDEK = await openBundleWithRecoveryEntropy(
      bundleFromJSON(legacyJson),
      args.recoveryEntropy,
    );
    try {
      return deriveSubDEK(masterDEK, 'blob-store');
    } finally {
      masterDEK.fill(0);
    }
  }
  return null;
};

/** Blob-encryption fix Phase 3 + D-212 — derive the re-encryption key for the
 *  encrypted CAS roots (`cache_blobs` / `memory_blobs`) from the archive's
 *  server-bundle sidecar record plus the STAGED db's legacy fallback, so restored
 *  blobs are re-encrypted under the key the POST-restore server will read them
 *  with. That key is the RESTORED realm's — its archive record carries the
 *  server bundle (with the staged db's legacy password bundle as fallback), and
 *  the post-restore server boots on exactly this db + sidecar and auto-unlocks
 *  the same Master DEK. The staged db is opened READ-ONLY only for that fallback.
 *
 *  Returns null when the archive's realm is KEYLESS (no bundle) — the encrypted
 *  roots are then built keyless (plaintext), matching the restored realm. A
 *  wrong recovery key throws (GCM tag) → the restore aborts before the swap. */
export const deriveRestoreBlobKey = async (
  stagedDbPath: string,
  serverBundle: ServerBundle | null,
  recoveryEntropy: Uint8Array,
): Promise<Uint8Array | null> => {
  const databaseKey = serverBundle
    ? await deriveDatabaseKeyFromRecoveryEntropy(serverBundle, recoveryEntropy)
    : null;
  let db: Database.Database;
  try {
    db = await openDatabase(stagedDbPath, {
      readonly: true,
      fileMustExist: true,
      databaseKey,
    });
  } finally {
    databaseKey?.fill(0);
  }
  try {
    // FAIL-CLOSED guard against the one fragile assumption here: this key is
    // derived at the moment an encrypted blob is overlaid, which is safe ONLY
    // because the exporter emits the db record FIRST and it is fully flushed
    // (makeFileSink.end() awaits `finished`) before any blob. If a malformed /
    // reordered archive presented an encrypted blob BEFORE the db, `dbDestPath`
    // would be the eagerly-created EMPTY sink file — 0 tables — and a null
    // bundle read below would silently build KEYLESS targets, writing the
    // encrypted blobs as PLAINTEXT (unreadable by the encrypted post-restore
    // realm). A real restored db always carries tables (bin.ts seeds
    // server_config / server_state / …), so 0 tables ⇒ the db isn't written yet
    // ⇒ REFUSE rather than fail open into a silent-loss restore. (This guard is
    // restore-specific — it defends the streamed-archive ordering, so it lives
    // here rather than in the shared `deriveBlobStoreKey`.)
    const tableCount = (
      db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }
    ).n;
    if (tableCount === 0) {
      throw new Error(
        'ARCHIVE_INVALID: staged db is empty when the blob re-encryption key was needed — an encrypted blob record precedes the db record',
      );
    }
    return await deriveBlobStoreKey({ db, serverBundle, recoveryEntropy });
  } finally {
    db.close();
    // A readonly open of a WAL-mode logical copy can create `-wal`/`-shm`
    // sidecars next to it (the source db is WAL-mode); the offline restore
    // renames only the main file, so reap the residue here — best-effort, they
    // hold no unique data.
    for (const suffix of ['-wal', '-shm']) {
      try { unlinkSync(`${stagedDbPath}${suffix}`); } catch { /* absent — fine */ }
    }
  }
};

/** The post-stream view both restore entry points need from one streaming
 *  pass: the db has been written to `dbDestPath`, blobs overlaid, config
 *  buffered. The live `dbPath` is UNTOUCHED — the caller commits. */
interface RestoreStreamResult {
  manifest: ArchiveManifest;
  config?: Buffer;
  serverVaultBundle?: Buffer;
  passportPresent: boolean;
  /** The embedded `passport.json` bytes when present (for the M5 S1 provenance
   *  marker) — a KB-scale signed projection the importer buffers whole. */
  passportBytes?: Buffer;
  db_bytes: number;
  blob_count: number;
  /** Live CAS objects the overlay wrote over. Empty on the common path; the
   *  online caller carries them across the drain so a discarded restore can
   *  put them back. */
  displacedBlobs: DisplacedBlob[];
}

/** Replace an archive bundle's source-machine server wrap with a wrap under
 * this destination's keyfile key. The recovery wrap + Master DEK stay intact,
 * so the staged encrypted db keeps the same database key while normal boot no
 * longer depends on the lost/source keyfile. */
const localizeRestoredServerBundle = async (
  dbPath: string,
  bytes: Buffer | undefined,
  recoveryEntropy: Uint8Array,
  now?: () => number,
): Promise<Buffer | undefined> => {
  if (bytes === undefined) return undefined;
  const rebound = await rebindServerBundleForLocalBoot(
    dbPath,
    serverBundleFromJSON(bytes.toString('utf8')),
    recoveryEntropy,
    now ? { now } : {},
  );
  return Buffer.from(serverBundleToJSON(rebound), 'utf8');
};

/** Drive `streamImportArchive` into `dataPath`: stream the db to
 *  `dbDestPath` (a SIDE path — temp offline, staging online), overlay each
 *  blob into the CAS, buffer the config. On ANY failure, tear down the db
 *  sink + remove the partial `dbDestPath` so the caller never sees a torn
 *  side file (already-overlaid CAS blobs are content-addressed orphans the
 *  sweep reaps — harmless, since the db swap never happens). */
const streamRestoreInto = async (
  dataPath: string,
  dbDestPath: string,
  importOpts: ImportOptions,
  /** The LIVE realm's db path (not the staged one), so the encryption-posture
   *  gate below can see what this restore is about to replace. */
  liveDbPath: string,
): Promise<RestoreStreamResult> => {
  // Root-routed target stores. D-212 slice 4 keys ALL three production roots,
  // including the historical `blobs/` namespace used by shared + annotation.
  // They are built LAZILY on the first blob that needs them —
  // by then the db + server-vault sidecar records have been authenticated, so
  // we can derive the archive realm's re-encryption key. Memoized
  // (the key is derived exactly once). An archive with blob records but no
  // server bundle now fails closed; production restore never writes plaintext.
  let sharedStore: BlobStore | undefined;
  let cacheStore: BlobStore | undefined;
  let memoryStore: BlobStore | undefined;
  const restoreBlobKeyRef: { current: Uint8Array | null } = { current: null };
  let serverBundle: ServerBundle | null = null;
  let serverVaultBundle: Buffer | undefined;
  // Derive the key + build all encrypted targets exactly once. A PROMISE memo
  // (not a boolean-before-await) so even if the stream were ever made
  // concurrent, a second caller awaits the same in-flight derivation rather
  // than reading a still-undefined store.
  let encStoresPromise: Promise<void> | undefined;
  // Live CAS objects this overlay wrote over, so an abort can put them back.
  const displacedBlobs: DisplacedBlob[] = [];
  const rootFor = (namespace: BlobNamespace): string =>
    join(dataPath, namespace === 'cache' ? 'cache_blobs' : namespace === 'memory' ? 'memory_blobs' : 'blobs');
  const targetFor = async (namespace: BlobNamespace): Promise<BlobStore> => {
    encStoresPromise ??= (async () => {
      const blobKey = await deriveRestoreBlobKey(
        dbDestPath,
        serverBundle,
        importOpts.recoveryKey,
      );
      if (!blobKey) {
        throw new Error(
          'D212_BLOB_KEY_REQUIRED: archive contains blob records but the restored realm has no server vault bundle',
        );
      }
      restoreBlobKeyRef.current = blobKey;
      const getBlobKey = () => restoreBlobKeyRef.current;
      sharedStore = createEncryptedBlobStore(join(dataPath, 'blobs'), getBlobKey);
      cacheStore = createEncryptedBlobStore(join(dataPath, 'cache_blobs'), getBlobKey);
      memoryStore = createEncryptedBlobStore(join(dataPath, 'memory_blobs'), getBlobKey);
    })();
    await encStoresPromise;
    if (namespace === 'cache') return cacheStore!;
    if (namespace === 'memory') return memoryStore!;
    return sharedStore!;
  };

  let blob_count = 0;
  let config: Buffer | undefined;
  let passportPresent = false;
  let passportBytes: Buffer | undefined;

  const dbSink = makeFileSink(dbDestPath, { durable: true });
  // A blob streams to a temp file one at a time; each registers a cleanup so a
  // mid-blob abort — where its `end` never runs — can tear the write stream
  // down + reclaim the temp in the catch below (else a partial
  // `.restore-blob-*.tmp` would leak in the data dir). A Set (vs a captured
  // `let`) keeps the cleanup reachable from the catch without CFA narrowing it.
  const pendingBlobCleanup = new Set<() => void>();
  const consumer: ImportConsumer = {
    onDb: () => dbSink,
    onBlob: (hash, namespace) => {
      // Stream the blob to a temp file, then content-address it into the CAS via
      // putFile (peak = one chunk) — never buffer the whole (GB-scale) blob in
      // RAM (M-blob). The importer feeds `write` plaintext chunks incrementally;
      // `targetFor` routes to the posture store (re-encrypting when encrypted).
      const tmp = restoreBlobScratchPath(dataPath);
      const sink = makeFileSink(tmp);
      const cleanup = (): void => {
        try { sink.destroy(); } catch { /* ignore */ }
        try { unlinkSync(tmp); } catch { /* ignore */ }
      };
      pendingBlobCleanup.add(cleanup);
      return {
        write: (c) => sink.write(c),
        end: async () => {
          try {
            await sink.end();
            await overlaySingleBlobFile(await targetFor(namespace), hash, tmp, {
              root: rootFor(namespace),
              into: displacedBlobs,
            });
            blob_count += 1;
          } finally {
            pendingBlobCleanup.delete(cleanup);
            try { unlinkSync(tmp); } catch { /* putFile read it; best-effort */ }
          }
        },
      };
    },
    onSmallRecord: (name, bytes) => {
      if (name === FILE_NAMES.config) config = bytes;
      else if (name === FILE_NAMES.serverVault) {
        // Parse at the authenticated archive boundary. A malformed sidecar must
        // abort staging even when the archive has no encrypted blob records.
        serverBundle = serverBundleFromJSON(bytes.toString('utf8'));
        serverVaultBundle = bytes;
      }
      else if (name === FILE_NAMES.passport) {
        passportPresent = true;
        // Keep the bytes (KB-scale) so the commit can stage them for the
        // post-restart provenance hook (M5 S1).
        passportBytes = bytes;
      }
    },
  };

  try {
    const summary = await streamImportArchive(importOpts, consumer);
    // Encryption-posture gate. Slice 4 refuses a keyless archive that carries
    // BLOBS, but that refusal lives inside `targetFor`, which only a blob can
    // reach — so a db-ONLY keyless archive walked straight past it and
    // committed a plaintext database over an encrypted realm, dropping the
    // sidecar on the way out. The database is the asset this whole arc exists
    // to protect, so the gate cannot be reachable only via blobs.
    //
    // Refuse rather than keep the old sidecar: a plaintext db paired with an
    // encrypted realm's bundle fails closed at the next open
    // (`D212_DATABASE_PLAINTEXT_REJECTED`), so retaining it would brick the
    // install instead of saving it. A keyless→keyless restore is untouched.
    if (!serverBundle && existsSync(resolveServerBundlePath(liveDbPath))) {
      throw new Error(
        'D212_REALM_DOWNGRADE_REFUSED: this archive carries no server vault bundle, but the realm it would replace is encrypted — restoring it would leave the database in plaintext',
      );
    }
    return {
      manifest: summary.manifest,
      config,
      ...(serverVaultBundle !== undefined ? { serverVaultBundle } : {}),
      passportPresent,
      ...(passportBytes !== undefined ? { passportBytes } : {}),
      db_bytes: summary.dbBytes,
      blob_count,
      displacedBlobs,
    };
  } catch (err) {
    dbSink.destroy();
    try { unlinkSync(dbDestPath); } catch { /* never landed — best effort */ }
    // A blob mid-stream when the import aborted: tear its write stream down +
    // reclaim its temp (its `end` cleanup never ran). Blobs overlaid at a hash
    // nothing held are content-addressed CAS orphans the sweep reaps — harmless,
    // the db swap never happens. Blobs overlaid OVER a live object are not
    // orphans: the surviving database still references them, so put the
    // pre-restore versions back.
    for (const cleanup of pendingBlobCleanup) cleanup();
    rollBackDisplacedBlobs(displacedBlobs);
    throw err;
  } finally {
    // Null it, don't just zero it. `getBlobKey` closes over this ref for every
    // store built above, and a wiped-but-present buffer is still a key — the
    // stores would go on encrypting under 32 zero bytes. Only null reaches
    // `requireKey`'s locked throw, which is the fail-closed posture the whole
    // provider indirection exists for.
    restoreBlobKeyRef.current?.fill(0);
    restoreBlobKeyRef.current = null;
  }
};

/** Stream an archive's db record to `tmpDbPath` for a READ-ONLY preview
 *  (the rpc `readManifest` / dry-run), authenticating every record's GCM
 *  tag + the HMAC along the way but WITHOUT overlaying blobs into the CAS
 *  (a preview must not mutate the warehouse). The caller opens the temp db
 *  read-only to count rows, then deletes it; on failure here the temp is
 *  reclaimed before the throw. */
export const previewToTempDb = async (
  tmpDbPath: string,
  importOpts: ImportOptions,
): Promise<{
  manifest: ArchiveManifest;
  passportPresent: boolean;
  db_bytes: number;
  serverVaultBundle?: Buffer;
}> => {
  const dbSink = makeFileSink(tmpDbPath);
  let passportPresent = false;
  let serverVaultBundle: Buffer | undefined;
  try {
    const summary = await streamImportArchive(importOpts, {
      onDb: () => dbSink,
      onBlob: () => DISCARD_RECORD_WRITER,
      onSmallRecord: (name, bytes) => {
        if (name === FILE_NAMES.serverVault) {
          serverBundleFromJSON(bytes.toString('utf8'));
          serverVaultBundle = bytes;
        }
        if (name === FILE_NAMES.passport) passportPresent = true;
      },
    });
    return {
      manifest: summary.manifest,
      passportPresent,
      db_bytes: summary.dbBytes,
      ...(serverVaultBundle !== undefined ? { serverVaultBundle } : {}),
    };
  } catch (err) {
    dbSink.destroy();
    try { unlinkSync(tmpDbPath); } catch { /* never landed — best effort */ }
    throw err;
  }
};

/** Did OUR swap leave a marker behind — i.e. is the marker on disk evidence
 *  that this restore's recovery failed and boot must finish it?
 *
 *  `markerBefore` is the answer to "was one already there when we started". A
 *  bare `existsSync` conflates our own failed recovery with a foreign journal
 *  left by an earlier interrupted restore, and the two want opposite handling:
 *  ours means PRESERVE the staged db as evidence, theirs means our staging is
 *  garbage that must be discarded and our parks rolled back. */
const ourSwapLeftAMarker = (dbPath: string, markerBefore: boolean): boolean =>
  existsSync(resolveServerBundleSwapMarkerPath(dbPath)) && !markerBefore;

/** Restore an archive into a STOPPED server's `data_path` (the offline
 *  `archive` CLI path). Streams the archive — see the module header for the
 *  step-by-step safety contract. Throws `ARCHIVE_RESTORE_SERVER_LIVE`
 *  when a live server is detected without `force`,
 *  `ARCHIVE_INVALID_SIGNATURE` on a wrong key / tamper (before any commit),
 *  and `ARCHIVE_RESTORE_BLOB_HASH_MISMATCH` if a blob fails its
 *  content-address round-trip. */
export const applyRestore = async (
  targets: RestoreTargets,
  importOpts: ImportOptions,
  opts: ApplyRestoreOptions = {},
): Promise<RestoreResult> => {
  const { dbPath, dataPath, configPath } = targets;
  const force = opts.force ?? false;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const startedAt = (opts.now ?? Date.now)();

  // ── 1. Running-server guard (before we touch ANYTHING) ───────────
  // A live holder means the engine still has the db open; writing under
  // it corrupts both. A *stale* lock (holder PID dead) is crash debris —
  // ignore it and proceed.
  const lock = createInstanceLock({ lockPath: join(dataPath, SERVER_LOCK_FILE) });
  const holder = lock.inspect();
  if (holder && isProcessAlive(holder.pid) && !force) {
    throw new Error(
      `ARCHIVE_RESTORE_SERVER_LIVE: server appears to be running ` +
        `(pid ${holder.pid}, port ${holder.bind_port}). Stop it first, or pass --force.`,
    );
  }

  // ── 2. Settle any earlier interrupted swap BEFORE looking at this realm ──
  // An offline restore can run without a prior server boot, so nothing has
  // reconciled the journal yet and the realm's artifacts may still be sitting
  // under an interrupted swap's backup names. Everything below reads the live
  // paths to decide what this realm IS — above all the encryption-posture gate
  // in `streamRestoreInto`, which refuses a keyless archive over an encrypted
  // realm by asking whether the bundle sidecar exists. Asked while a pre-commit
  // swap had that sidecar parked, the answer was "no bundle" and a keyless
  // archive committed straight over an encrypted realm, leaving it plaintext.
  //
  // It has to be HERE, ahead of the stream: reconciling any later means our own
  // overlay has already parked blobs in the same CAS, and an older
  // transaction's rollback cannot then be told apart from ours.
  const settled = reconcileServerBundleSwap(
    dbPath,
    (committed) => {
      // A FOREIGN transaction's parks — ours do not exist yet, which is exactly
      // why this runs before the stream. The CAS walk is the only way to reach
      // them: an interrupted restore left no in-process list behind.
      return reclaimDisplacedBlobs(dataPath, committed).complete;
    },
    { configPath },
  );
  // ⛔ A verdict is not a clean slate. `retired: false` means the pair WAS
  // repaired but a park could not be resolved, so the marker was deliberately
  // kept for the next boot to finish. Starting a restore on top of that streams
  // a whole archive — parking blobs in the same CAS — only for
  // `prepareServerBundleSwap` to refuse on the surviving marker afterwards,
  // leaking the staged db and stranding this restore's overlay under the OLD
  // database. Refuse HERE, before anything is written.
  if (!settled.retired) {
    throw new Error(
      'ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: an earlier interrupted restore left parked blob '
        + `originals that could not be resolved, so its journal at ${resolveServerBundleSwapMarkerPath(dbPath)} `
        + 'is still open. Start the server once to let boot finish it (or clear the stranded '
        + `.pre-restore- files under ${dataPath}), then restore again.`,
    );
  }
  if (settled.recovery !== 'none') {
    console.warn(
      `[archive] ${settled.recovery} an interrupted db + server-bundle swap before restoring`,
    );
  }

  // ── 3. Stream into a temp db beside dbPath + overlay blobs + buffer
  // config. Nothing here touches the live dbPath; a verification failure
  // throws here (temp reclaimed by streamRestoreInto) before any commit.
  const restoreTmp = `${dbPath}.restore-${randomBytes(8).toString('hex')}.tmp`;
  const streamed = await streamRestoreInto(dataPath, restoreTmp, importOpts, dbPath);

  // The archive carries the SOURCE machine's normal-boot wrap. Before the
  // journaled pair swap, rewrap the same Master DEK to the destination keyfile;
  // otherwise recovery-key restore would succeed but the next boot would fail.
  try {
    streamed.serverVaultBundle = await localizeRestoredServerBundle(
      dbPath,
      streamed.serverVaultBundle,
      importOpts.recoveryKey,
      () => startedAt,
    );
  } catch (err) {
    discardStagedRestore(restoreTmp, streamed.displacedBlobs);
    throw err;
  }

  // The archive is now fully verified and the db sits at `restoreTmp`.
  const stamp = makeBackupStamp(startedAt);
  // Snapshot BEFORE the swap so the catch can tell our own failed recovery from
  // a foreign journal — see `ourSwapLeftAMarker`.
  const markerBefore = existsSync(resolveServerBundleSwapMarkerPath(dbPath));
  let swap: ReturnType<typeof commitPreparedServerBundleSwap>;
  try {
    // ── 4. Config + db + bundle share one durable commit verdict ──
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: restoreTmp,
      stamp,
      ...(streamed.serverVaultBundle !== undefined
        ? { nextBundle: streamed.serverVaultBundle }
        : {}),
      configPath,
      ...(streamed.config !== undefined ? { nextConfig: streamed.config } : {}),
    });
    // ── 5. Journaled commit: old pair aside, db commit point, new bundle ──
    // The parks ride the journal: their fate is this swap's verdict, and the
    // marker is the only durable record of it (see `server-bundle-swap`).
    swap = commitPreparedServerBundleSwap(prepared, (committed) =>
      committed
        ? reapDisplacedBlobs(streamed.displacedBlobs)
        : rollBackDisplacedBlobs(streamed.displacedBlobs));
  } catch (err) {
    // If automatic pair recovery itself failed, preserve the marker + staged
    // db: boot needs both to distinguish pre-commit rollback from post-commit
    // completion. Reaping the staging signal here would make that ambiguous.
    //
    // ⚠ "OUR marker", not "a marker". The test is evidence that THIS swap's
    // recovery failed, and a foreign marker left by an earlier interrupted
    // restore satisfies `existsSync` just as well — which would preserve a
    // staged db nothing will ever consume and strand this restore's parks. The
    // guard above makes a foreign marker unreachable here; this keeps the catch
    // true on its own terms rather than by appeal to a distant precondition.
    if (!ourSwapLeftAMarker(dbPath, markerBefore)) {
      discardStagedRestore(restoreTmp, streamed.displacedBlobs);
    }
    throw err;
  }
  const backups = [...swap.backups];

  // Commit landed — stage the embedded passport (if any) so the next server
  // boot records the migration provenance (M5 S1). Offline restore is the
  // `archive` CLI on a STOPPED server, so the marker simply waits for the
  // operator's next `serve`. Best-effort: never undoes a committed restore.
  stageRestoreProvenanceMarker(dataPath, streamed.passportBytes, { now: () => startedAt });
  // The parks were reaped INSIDE the commit, while the swap marker still
  // existed to justify it. Reaping them here — after the marker was gone —
  // is what let a kill in between look like an uncommitted restore.

  return {
    restored_at: startedAt,
    db_bytes: streamed.db_bytes,
    blob_count: streamed.blob_count,
    config_written: swap.configWritten,
    db_backup_path: swap.dbBackupPath,
    backups,
  };
};

/** ONLINE step 1 — stage the restore BESIDE the live db while the server
 *  keeps serving. Streams the db to `dbPath.staging`, overlays blobs
 *  (additive, content-addressed), buffers config. The live db at `dbPath`
 *  is COMPLETELY UNTOUCHED — if this throws (verification failure included),
 *  the staged side file is reclaimed and the caller aborts cleanly (server
 *  stays up, no restart). No instance-lock guard: the online caller IS the
 *  live server and owns the drain that quiesces writers before the commit.
 *  Returns a SMALL descriptor (no db bytes) for the deferred commit. */
export const stageRestore = async (
  targets: RestoreTargets,
  importOpts: ImportOptions,
): Promise<StagedRestore> => {
  const { dbPath, dataPath } = targets;
  // ⛔ Same precondition the offline path enforces, minus the repair: this runs
  // with the server LIVE and the db OPEN, so reconciling here would rename
  // files under an open SQLite handle. Refuse instead. Boot reconciles, and a
  // marker that survived boot means a park could not be resolved — starting a
  // restore on that would stream the whole archive, park blobs in the same CAS,
  // and be refused at commit, leaking both.
  if (existsSync(resolveServerBundleSwapMarkerPath(dbPath))) {
    throw new Error(
      'ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED: an earlier interrupted restore left an open '
        + `journal at ${resolveServerBundleSwapMarkerPath(dbPath)}. Restart the server so boot can `
        + 'finish it, then import again.',
    );
  }
  const stagingPath = uniqueStagingDbPath(dbPath);
  const streamed = await streamRestoreInto(dataPath, stagingPath, importOpts, dbPath);
  try {
    streamed.serverVaultBundle = await localizeRestoredServerBundle(
      dbPath,
      streamed.serverVaultBundle,
      importOpts.recoveryKey,
    );
  } catch (err) {
    discardStagedRestore(stagingPath, streamed.displacedBlobs);
    throw err;
  }
  return {
    stagingPath,
    blob_count: streamed.blob_count,
    db_bytes: streamed.db_bytes,
    config: streamed.config,
    displacedBlobs: streamed.displacedBlobs,
    ...(streamed.serverVaultBundle !== undefined
      ? { serverVaultBundle: streamed.serverVaultBundle }
      : {}),
    manifest: streamed.manifest,
    passportPresent: streamed.passportPresent,
    ...(streamed.passportBytes !== undefined
      ? { passportBytes: streamed.passportBytes }
      : {}),
  };
};

/** Best-effort removal of a staged db (+ any sidecars an opened staging
 *  handle left behind). Takes the EXACT staging path from the `StagedRestore`
 *  descriptor (never recomputes a fixed path) so it only ever removes THIS
 *  restore's file — concurrent restores can't reap each other's staging.
 *  Called on abort, and after a successful commit consumed the staging file. */
export const discardStagedRestore = (
  stagingPath: string,
  /** Live CAS objects the staging overlay wrote over. A discard means the OLD
   *  database keeps serving, so the archive's versions must not survive under
   *  hashes it still references. */
  displacedBlobs: readonly DisplacedBlob[] = [],
): void => {
  for (const p of [
    stagingPath,
    `${stagingPath}-wal`,
    `${stagingPath}-shm`,
    resolveServerBundlePath(stagingPath),
  ]) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
  }
  rollBackDisplacedBlobs(displacedBlobs);
};

/** ONLINE step 2 — commit a previously staged restore by atomic rename.
 *  PRECONDITION: the live db handle is already CLOSED (the restart drain's
 *  `close_db` step did this) and `stageRestore` has written its staged db.
 *  Backs up the old db + sidecars aside, writes config, then renames the
 *  staged db onto `dbPath` — the commit point. No live-server guard: by
 *  the time this runs the drain has quiesced every writer, closed the db,
 *  and released the lock. Throws if the staged db is missing. */
export const commitStagedRestore = async (
  targets: RestoreTargets,
  staged: StagedRestore,
  opts: { now?: () => number } = {},
): Promise<RestoreResult> => {
  const { dbPath, dataPath, configPath } = targets;
  const startedAt = (opts.now ?? Date.now)();
  // Use the path stage wrote (carried on the descriptor) rather than
  // recomputing it — keeps commit anchored to THIS restore's staged file.
  const stagingPath = staged.stagingPath;
  if (!existsSync(stagingPath)) {
    // The commit cannot proceed, so the OLD database keeps serving — and it
    // still references whatever the overlay wrote over. Throwing straight out
    // of here left those parked originals stranded and the live blobs holding
    // the archive realm's bytes.
    rollBackDisplacedBlobs(staged.displacedBlobs ?? []);
    throw new Error(
      `ARCHIVE_RESTORE_STAGING_MISSING: expected staged db at ${stagingPath}`,
    );
  }

  const stamp = makeBackupStamp(startedAt);
  const markerBefore = existsSync(resolveServerBundleSwapMarkerPath(dbPath));
  let swap: ReturnType<typeof commitPreparedServerBundleSwap>;
  try {
    // `commitStagedRestore` is exported, so retain the sidecar shape gate even
    // when a caller constructs the descriptor instead of using `stageRestore`.
    if (staged.serverVaultBundle !== undefined) {
      serverBundleFromJSON(staged.serverVaultBundle.toString('utf8'));
    }
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp,
      ...(staged.serverVaultBundle !== undefined
        ? { nextBundle: staged.serverVaultBundle }
        : {}),
      configPath,
      ...(staged.config !== undefined ? { nextConfig: staged.config } : {}),
    });
    // As offline: the parks belong to the journal, because only the marker
    // records the verdict they are waiting on.
    swap = commitPreparedServerBundleSwap(prepared, (committed) =>
      committed
        ? reapDisplacedBlobs(staged.displacedBlobs ?? [])
        : rollBackDisplacedBlobs(staged.displacedBlobs ?? []));
  } catch (err) {
    // An ordinary pre-commit failure has already rolled the original pair back;
    // remove its nonce-named decrypted staging copy. If recovery itself failed,
    // the marker remains and the staged db is load-bearing evidence for boot,
    // so preserve both rather than turning the state ambiguous. Same
    // OURS-not-ANY test as the offline path — `commitStagedRestore` is exported
    // and can be reached with a caller-built descriptor that never passed
    // `stageRestore`'s guard.
    if (!ourSwapLeftAMarker(dbPath, markerBefore)) {
      discardStagedRestore(stagingPath, staged.displacedBlobs);
    }
    throw err;
  }
  // Parks: reaped inside the commit, under the marker — see the offline path.
  const backups = [...swap.backups];

  // Clean up any staging sidecars a read-only count handle may have left.
  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const sidecar = `${stagingPath}${suffix}`;
    try { if (existsSync(sidecar)) unlinkSync(sidecar); } catch { /* best effort */ }
  }

  // The swap committed — stage the embedded passport (if any) into a dataPath
  // marker so the post-restart boot records the old→new identity provenance
  // (M5 S1). After the swap so it only exists for a restore that actually
  // landed; best-effort so a marker failure never undoes a committed restore.
  stageRestoreProvenanceMarker(dataPath, staged.passportBytes, { now: () => startedAt });

  return {
    restored_at: startedAt,
    db_bytes: staged.db_bytes,
    blob_count: staged.blob_count,
    config_written: swap.configWritten,
    db_backup_path: swap.dbBackupPath,
    backups,
  };
};
