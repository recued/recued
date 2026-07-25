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
 *    3. Back up the existing db + its WAL/SHM sidecars before clobber.
 *    4. Write config (atomic), backing up the old one first.
 *    5. Commit the db LAST (temp/staging → `dbPath` rename) — the commit
 *       point; nothing before it touches dbPath. It runs only after the
 *       whole stream verified (every GCM tag + the HMAC trailer), so a
 *       wrong key / tamper aborts before the swap, leaving at most some
 *       harmless content-addressed CAS orphans the sweep reaps.
 *
 *  This is SAFETY, not migration: we write the archive's db verbatim. If
 *  it carries an older schema, the server's boot-time migration handles
 *  it — restore adds no migration logic.
 */

import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import Database from 'better-sqlite3';
import {
  bundleFromJSON,
  serverBundleFromJSON,
  openBundleWithRecoveryEntropy,
  openServerBundleWithRecoveryEntropy,
  deriveSubDEK,
} from '@recued/crypto';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createInstanceLock } from '../lifecycle/instance-lock.js';
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
  /** Bytes of the restored db file (decrypted plaintext). */
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
  /** Where `stageRestore` wrote the decrypted db. */
  stagingPath: string;
  /** Blobs overlaid into the CAS. */
  blob_count: number;
  /** Decrypted db plaintext byte count (for the result report). */
  db_bytes: number;
  /** The archive's config record, when present + a config path is known. */
  config?: Buffer;
  /** The on-disk archive manifest (for the wire-manifest mapping). */
  manifest: ArchiveManifest;
  /** Whether the archive embedded a `passport.json`. */
  passportPresent: boolean;
  /** The archive's embedded `passport.json` bytes (a signed `migration_full`
   *  projection) when present — staged into a `dataPath` marker at commit so
   *  the post-restart boot can record the migration provenance (M5 S1). The
   *  KB-scale record is already buffered whole by the importer. */
  passportBytes?: Buffer;
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

const makeFileSink = (destPath: string): FileSink => {
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ws = createWriteStream(destPath);
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
    },
    destroy: () => { ws.destroy(); },
  };
};

/** Write `data` to `destPath` via a same-dir temp file + atomic rename,
 *  mirroring `blob-store`'s publish discipline: a crash / ENOSPC mid-write
 *  strands at most a `.tmp-restore-*` file, never a torn config. Used for
 *  the small config record; the db streams via `makeFileSink`. */
const atomicWriteFile = (destPath: string, data: Buffer): void => {
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.tmp-restore-${basename(destPath)}-${randomBytes(8).toString('hex')}`,
  );
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, destPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* never landed — best effort */ }
    throw err;
  }
};

/** Overlay ONE blob into the CAS via a target store, content-addressed +
 *  STREAMING (peak = one chunk, never the whole blob in RAM — the M-blob win).
 *  `blobStore` is the posture-routed target (blob-encryption fix Phase 3):
 *  keyless for `blobs/`, encrypted for `cache-blobs/` / `memory-blobs/`. The
 *  archive carries PLAINTEXT (Phase 2), so `putFile` content-addresses over the
 *  plaintext temp — computing `hash` = sha256(plaintext) — and re-encrypts under
 *  the target store's key when encrypted; `written === hash` therefore holds for
 *  both postures. Throws `ARCHIVE_RESTORE_BLOB_HASH_MISMATCH` if the bytes don't
 *  content-address to `hash`. */
export const overlaySingleBlobFile = async (
  blobStore: BlobStore,
  hash: string,
  srcPath: string,
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
  const written = await blobStore.putFile(srcPath, { replace: true });
  if (written !== hash) {
    throw new Error(
      `ARCHIVE_RESTORE_BLOB_HASH_MISMATCH: blob named ${hash} content-addressed to ${written}`,
    );
  }
};

/** Blob-encryption fix — read the realm's `blob-store` sub-DEK from an OPEN db
 *  handle: unwrap the Master DEK from the db's SERVER bundle (D-197 live
 *  self-host encryption) — or the legacy password bundle (`keys.init`-enrolled
 *  realm) as a fallback — with the recovery ENTROPY, then derive the
 *  `blob-store` sub-DEK. Returns null for a KEYLESS realm (no bundle → the
 *  encrypted roots are plaintext there). A wrong recovery key throws (GCM tag).
 *  Reads `server_config` only; never writes.
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
 *    - restore (`deriveRestoreBlobKey`) — the re-encryption target key, read
 *      from the STAGED db (the archive's own db carries its server bundle).
 *    - offline export (`cmdExport`) — the decrypt-on-export key, read from the
 *      LIVE source db. */
export const deriveBlobStoreKeyFromDb = async (
  db: Database.Database,
  recoveryEntropy: Uint8Array,
): Promise<Uint8Array | null> => {
  // Older schema (no `server_config` table at all) → a genuinely KEYLESS realm.
  // Probe the schema catalog (never throws on a missing table) so a REAL read
  // error below is NOT swallowed into a false "keyless" — which on an ENCRYPTED
  // realm would archive ciphertext.
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
  // D-197 live self-host encryption uses the SERVER bundle; the legacy
  // password bundle is the fallback for a `keys.init`-enrolled realm.
  const serverJson = readConfig('server_vault_bundle');
  if (serverJson) {
    const masterDEK = await openServerBundleWithRecoveryEntropy(
      serverBundleFromJSON(serverJson),
      recoveryEntropy,
    );
    return deriveSubDEK(masterDEK, 'blob-store');
  }
  const legacyJson = readConfig('bundle');
  if (legacyJson) {
    const masterDEK = await openBundleWithRecoveryEntropy(
      bundleFromJSON(legacyJson),
      recoveryEntropy,
    );
    return deriveSubDEK(masterDEK, 'blob-store');
  }
  return null;
};

/** Blob-encryption fix Phase 3 — derive the re-encryption key for the encrypted
 *  CAS roots (`cache_blobs` / `memory_blobs`) from the STAGED db, so restored
 *  blobs are re-encrypted under the key the POST-restore server will read them
 *  with. That key is the RESTORED realm's — the archive's db carries its own
 *  vault bundle (server-bundle preferred, legacy fallback), and the post-restore
 *  server boots on exactly this db + auto-unlocks the same Master DEK. We read
 *  it from `stagedDbPath` (the db record is fully written before any blob
 *  overlays), opening the db READ-ONLY, and delegate the unwrap-and-derive to
 *  `deriveBlobStoreKeyFromDb` (shared with offline export).
 *
 *  Returns null when the archive's realm is KEYLESS (no bundle) — the encrypted
 *  roots are then built keyless (plaintext), matching the restored realm. A
 *  wrong recovery key throws (GCM tag) → the restore aborts before the swap. */
export const deriveRestoreBlobKey = async (
  stagedDbPath: string,
  recoveryEntropy: Uint8Array,
): Promise<Uint8Array | null> => {
  const db = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
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
    // here rather than in the shared `deriveBlobStoreKeyFromDb`.)
    const tableCount = (
      db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }
    ).n;
    if (tableCount === 0) {
      throw new Error(
        'ARCHIVE_INVALID: staged db is empty when the blob re-encryption key was needed — an encrypted blob record precedes the db record',
      );
    }
    return await deriveBlobStoreKeyFromDb(db, recoveryEntropy);
  } finally {
    db.close();
    // A readonly open of a WAL-mode `db.backup()` copy creates `-wal`/`-shm`
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
  passportPresent: boolean;
  /** The embedded `passport.json` bytes when present (for the M5 S1 provenance
   *  marker) — a KB-scale signed projection the importer buffers whole. */
  passportBytes?: Buffer;
  db_bytes: number;
  blob_count: number;
}

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
): Promise<RestoreStreamResult> => {
  // Posture-routed target stores (blob-encryption fix Phase 3). The keyless
  // `blobs/` root is always plaintext. The encrypted `cache_blobs` /
  // `memory_blobs` roots are built LAZILY on the first blob that needs them —
  // by then the db record is fully written to `dbDestPath`, so we can read the
  // archive realm's bundle from it to derive the re-encryption key. Memoized
  // (the key is derived exactly once). On a keyless-realm archive the derived
  // key is null → those roots are built keyless too (plaintext), matching the
  // restored realm.
  const keylessStore = createBlobStore(join(dataPath, 'blobs'));
  let cacheStore: BlobStore | undefined;
  let memoryStore: BlobStore | undefined;
  // Derive the key + build both encrypted targets exactly once. A PROMISE memo
  // (not a boolean-before-await) so even if the stream were ever made
  // concurrent, a second caller awaits the same in-flight derivation rather
  // than reading a still-undefined store.
  let encStoresPromise: Promise<void> | undefined;
  const targetFor = async (namespace: BlobNamespace): Promise<BlobStore> => {
    if (namespace === 'keyless') return keylessStore;
    encStoresPromise ??= (async () => {
      const blobKey = await deriveRestoreBlobKey(dbDestPath, importOpts.recoveryKey);
      const opts = blobKey ? { getEncryptionKey: () => blobKey } : {};
      cacheStore = createBlobStore(join(dataPath, 'cache_blobs'), opts);
      memoryStore = createBlobStore(join(dataPath, 'memory_blobs'), opts);
    })();
    await encStoresPromise;
    return namespace === 'cache' ? cacheStore! : memoryStore!;
  };

  let blob_count = 0;
  let config: Buffer | undefined;
  let passportPresent = false;
  let passportBytes: Buffer | undefined;

  const dbSink = makeFileSink(dbDestPath);
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
      const tmp = join(dataPath, `.restore-blob-${randomBytes(8).toString('hex')}.tmp`);
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
            await overlaySingleBlobFile(await targetFor(namespace), hash, tmp);
            blob_count += 1;
          } finally {
            pendingBlobCleanup.delete(cleanup);
            try { unlinkSync(tmp); } catch { /* putFile read it; best-effort */ }
          }
        },
      };
    },
    onSmallRecord: (name, bytes) => {
      // The archive's db already carries the bundle/vault table, so a
      // same-instance restore ignores `vault-bundle.json` entirely (it
      // exists only for the cross-machine passport / re-key path).
      if (name === FILE_NAMES.config) config = bytes;
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
    return {
      manifest: summary.manifest,
      config,
      passportPresent,
      ...(passportBytes !== undefined ? { passportBytes } : {}),
      db_bytes: summary.dbBytes,
      blob_count,
    };
  } catch (err) {
    dbSink.destroy();
    try { unlinkSync(dbDestPath); } catch { /* never landed — best effort */ }
    // A blob mid-stream when the import aborted: tear its write stream down +
    // reclaim its temp (its `end` cleanup never ran). Already-overlaid blobs are
    // content-addressed CAS orphans the sweep reaps — harmless, the db swap
    // never happens.
    for (const cleanup of pendingBlobCleanup) cleanup();
    throw err;
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
): Promise<{ manifest: ArchiveManifest; passportPresent: boolean; db_bytes: number }> => {
  const dbSink = makeFileSink(tmpDbPath);
  let passportPresent = false;
  try {
    const summary = await streamImportArchive(importOpts, {
      onDb: () => dbSink,
      onBlob: () => DISCARD_RECORD_WRITER,
      onSmallRecord: (name) => {
        if (name === FILE_NAMES.passport) passportPresent = true;
      },
    });
    return { manifest: summary.manifest, passportPresent, db_bytes: summary.dbBytes };
  } catch (err) {
    dbSink.destroy();
    try { unlinkSync(tmpDbPath); } catch { /* never landed — best effort */ }
    throw err;
  }
};

/** Back up the live db + its WAL/SHM sidecars by renaming them aside.
 *  Move (not copy) so the live db path is freed for the commit rename AND
 *  the stale WAL/SHM can't open against the new db. The moved files are
 *  the rollback set (strip `.bak-<stamp>` to restore). Returns the db
 *  backup path (or null when there was no prior db) + every backup made. */
const backupDbAndSidecars = (
  dbPath: string,
  stamp: string,
): { dbBackupPath: string | null; backups: string[] } => {
  const backups: string[] = [];
  let dbBackupPath: string | null = null;
  if (existsSync(dbPath)) {
    dbBackupPath = `${dbPath}.bak-${stamp}`;
    renameSync(dbPath, dbBackupPath);
    backups.push(dbBackupPath);
  }
  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      const dest = `${sidecar}.bak-${stamp}`;
      renameSync(sidecar, dest);
      backups.push(dest);
    }
  }
  return { dbBackupPath, backups };
};

/** Write the archive's config (atomic), backing up the old one first.
 *  Returns whether config was written + the config-backup path (or null). */
const writeConfigRecord = (
  configPath: string | null,
  config: Buffer | undefined,
  stamp: string,
): { written: boolean; backup: string | null } => {
  if (!config || !configPath) return { written: false, backup: null };
  let backup: string | null = null;
  if (existsSync(configPath)) {
    backup = `${configPath}.bak-${stamp}`;
    copyFileSync(configPath, backup); // copy: no window with config absent
  }
  atomicWriteFile(configPath, config);
  return { written: true, backup };
};

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

  // ── 2. Stream into a temp db beside dbPath + overlay blobs + buffer
  // config. Nothing here touches the live dbPath; a verification failure
  // throws here (temp reclaimed by streamRestoreInto) before any commit.
  const restoreTmp = `${dbPath}.restore-${randomBytes(8).toString('hex')}.tmp`;
  const streamed = await streamRestoreInto(dataPath, restoreTmp, importOpts);

  // The archive is now fully verified and the db sits at `restoreTmp`.
  const stamp = makeBackupStamp(startedAt);
  // ── 3. Back up the old db + WAL/SHM sidecars before clobber ──
  const { dbBackupPath, backups } = backupDbAndSidecars(dbPath, stamp);

  // From here the old db is at `.bak` and dbPath is empty, so ANY failure
  // before the temp→dbPath rename would leave the server with no db to boot.
  // Roll the original db + sidecars back into place on failure (restore
  // aborted) rather than booting on a missing db — mirrors commitStagedRestore.
  let cfg: { written: boolean; backup: string | null } = { written: false, backup: null };
  try {
    // ── 4. Config (atomic), backing up the old one first ──
    cfg = writeConfigRecord(configPath, streamed.config, stamp);
    // ── 5. Db LAST — commit by renaming the temp onto the freed dbPath ──
    renameSync(restoreTmp, dbPath);
  } catch (err) {
    try { unlinkSync(restoreTmp); } catch { /* best effort */ }
    if (dbBackupPath && !existsSync(dbPath)) {
      try { renameSync(dbBackupPath, dbPath); } catch { /* best effort */ }
    }
    for (const suffix of WAL_SIDECAR_SUFFIXES) {
      const moved = `${dbPath}${suffix}.bak-${stamp}`;
      if (existsSync(moved) && !existsSync(`${dbPath}${suffix}`)) {
        try { renameSync(moved, `${dbPath}${suffix}`); } catch { /* best effort */ }
      }
    }
    throw err;
  }
  if (cfg.backup) backups.push(cfg.backup);

  // Commit landed — stage the embedded passport (if any) so the next server
  // boot records the migration provenance (M5 S1). Offline restore is the
  // `archive` CLI on a STOPPED server, so the marker simply waits for the
  // operator's next `serve`. Best-effort: never undoes a committed restore.
  stageRestoreProvenanceMarker(dataPath, streamed.passportBytes, { now: () => startedAt });

  return {
    restored_at: startedAt,
    db_bytes: streamed.db_bytes,
    blob_count: streamed.blob_count,
    config_written: cfg.written,
    db_backup_path: dbBackupPath,
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
  const stagingPath = uniqueStagingDbPath(dbPath);
  const streamed = await streamRestoreInto(dataPath, stagingPath, importOpts);
  return {
    stagingPath,
    blob_count: streamed.blob_count,
    db_bytes: streamed.db_bytes,
    config: streamed.config,
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
export const discardStagedRestore = (stagingPath: string): void => {
  for (const p of [stagingPath, `${stagingPath}-wal`, `${stagingPath}-shm`]) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
  }
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
    throw new Error(
      `ARCHIVE_RESTORE_STAGING_MISSING: expected staged db at ${stagingPath}`,
    );
  }

  const stamp = makeBackupStamp(startedAt);

  // Back up the old db + WAL/SHM sidecars before clobber.
  const { dbBackupPath, backups } = backupDbAndSidecars(dbPath, stamp);

  // From here on the old db is at `.bak` and dbPath is empty, so ANY
  // failure before the staging rename lands would leave the server with
  // no db to boot. Roll the original back on failure (restore aborted)
  // rather than booting on a missing db.
  let cfg: { written: boolean; backup: string | null } = { written: false, backup: null };
  try {
    // Config (atomic), backing up the old one first.
    cfg = writeConfigRecord(configPath, staged.config, stamp);
    // Commit: rename the staged db onto the (now-freed) dbPath. dbPath was
    // renamed to .bak above, so this is a rename onto a NON-existent
    // target — platform-robust (no rename-over-open).
    renameSync(stagingPath, dbPath);
  } catch (err) {
    if (dbBackupPath && !existsSync(dbPath)) {
      try { renameSync(dbBackupPath, dbPath); } catch { /* best effort */ }
    }
    for (const suffix of WAL_SIDECAR_SUFFIXES) {
      const moved = `${dbPath}${suffix}.bak-${stamp}`;
      if (existsSync(moved) && !existsSync(`${dbPath}${suffix}`)) {
        try { renameSync(moved, `${dbPath}${suffix}`); } catch { /* best effort */ }
      }
    }
    // The commit aborted with the original db rolled back, so the staged db was
    // NOT consumed — remove it (+ sidecars). Staging paths are nonce-named, so
    // without this a failed post-drain commit strands a full DECRYPTED warehouse
    // copy beside the live db on every retry (disk exhaustion + sensitive
    // residue); the old fixed path was self-limiting because the next stage
    // overwrote it.
    discardStagedRestore(stagingPath);
    throw err;
  }
  if (cfg.backup) backups.push(cfg.backup);

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
    config_written: cfg.written,
    db_backup_path: dbBackupPath,
    backups,
  };
};
