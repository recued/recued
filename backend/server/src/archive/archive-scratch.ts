/** Archive plaintext scratch files in the server data dir, and the boot sweep
 *  that reclaims the ones a hard kill stranded.
 *
 *  Export, restore and chunked EGRESS all have to land a blob's PLAINTEXT on
 *  disk for a moment — export decrypts a CAS object to a scratch file so a
 *  GB-scale attachment never buffers in RAM, restore streams the archive's
 *  plaintext to a temp file so `putFile` can content-address it, and D-217
 *  stages a file's plaintext so an upload can read it one chunk at a time. All
 *  three unlink in a `finally`, which covers every ordinary failure but cannot
 *  run after SIGKILL, an OOM kill, or power loss. What survives is warehouse
 *  plaintext on a disk whose whole point is to hold ciphertext, so it needs an
 *  owner at the next boot.
 *
 *  `BlobStore.sweepOrphans` does not reach these: it reaps `.tmp-` files INSIDE
 *  the CAS shard directories, and these sit in the data dir root.
 *
 *  ⚠ Every name is built here so the sweep's pattern cannot drift from what the
 *  writers actually produce. A new writer that mints its own prefix elsewhere is
 *  invisible to `sweepBlobScratch` and strands plaintext forever — which is
 *  precisely why D-217's egress staging joined this module rather than picking
 *  its own path.
 */

import { randomBytes } from 'node:crypto';
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Export's per-blob scratch: `<dataPath>/.decrypt-<hash>-<nonce>.tmp`. */
export const EXPORT_BLOB_SCRATCH_PREFIX = '.decrypt-';

/** Restore's per-blob staging file: `<dataPath>/.restore-blob-<nonce>.tmp`. */
export const RESTORE_BLOB_SCRATCH_PREFIX = '.restore-blob-';

/** Export's consistent database snapshot. Enrolled databases remain encrypted,
 *  but a legacy/keyless realm's snapshot is plaintext, so it belongs inside the
 *  data volume and under the same boot reclaim as decrypted blob scratch. */
export const EXPORT_DB_SCRATCH_PREFIX = '.archive-export-db-';

/** Manifest preview's authenticated database image. Import decrypts this record
 *  before SQLite opens it, so a kill can otherwise leave a full plaintext realm
 *  copy in the data-dir root indefinitely. */
export const PREVIEW_DB_SCRATCH_PREFIX = '.archive-preview-db-';

/** D-217 slice 0 — chunked egress's staged plaintext:
 *  `<dataPath>/.egress-<nonce>.tmp`. Unlike export's, the name carries NO blob
 *  hash: this file exists to be read in ranges by an upload that may run for
 *  minutes, and a data-dir listing should not disclose WHICH warehouse object
 *  is currently being sent. */
export const EGRESS_BLOB_SCRATCH_PREFIX = '.egress-';

export const BLOB_SCRATCH_SUFFIX = '.tmp';

/** A fresh scratch path for ONE export blob. The nonce keeps concurrent exports
 *  of the same hash from colliding. */
export const exportBlobScratchPath = (dataPath: string, hash: string): string =>
  join(
    dataPath,
    `${EXPORT_BLOB_SCRATCH_PREFIX}${hash}-${randomBytes(6).toString('hex')}${BLOB_SCRATCH_SUFFIX}`,
  );

/** A fresh staging path for ONE restored blob. */
export const restoreBlobScratchPath = (dataPath: string): string =>
  join(
    dataPath,
    `${RESTORE_BLOB_SCRATCH_PREFIX}${randomBytes(8).toString('hex')}${BLOB_SCRATCH_SUFFIX}`,
  );

/** A fresh data-volume path for one export's consistent database snapshot. */
export const exportDatabaseScratchPath = (dataPath: string): string =>
  join(
    dataPath,
    `${EXPORT_DB_SCRATCH_PREFIX}${randomBytes(8).toString('hex')}${BLOB_SCRATCH_SUFFIX}`,
  );

/** A fresh data-volume path for one archive-manifest preview database. */
export const previewDatabaseScratchPath = (dataPath: string): string =>
  join(
    dataPath,
    `${PREVIEW_DB_SCRATCH_PREFIX}${randomBytes(8).toString('hex')}${BLOB_SCRATCH_SUFFIX}`,
  );

/** A fresh staging path for ONE egress upload's plaintext (D-217 slice 0). */
export const egressBlobScratchPath = (dataPath: string): string =>
  join(
    dataPath,
    `${EGRESS_BLOB_SCRATCH_PREFIX}${randomBytes(8).toString('hex')}${BLOB_SCRATCH_SUFFIX}`,
  );

/** ⚠ Every prefix a writer in this module mints must appear here, or the boot
 *  sweep silently walks past that writer's stranded plaintext. */
const isArchiveScratchName = (name: string): boolean =>
  name.endsWith(BLOB_SCRATCH_SUFFIX)
  && (name.startsWith(EXPORT_BLOB_SCRATCH_PREFIX)
    || name.startsWith(RESTORE_BLOB_SCRATCH_PREFIX)
    || name.startsWith(EXPORT_DB_SCRATCH_PREFIX)
    || name.startsWith(PREVIEW_DB_SCRATCH_PREFIX)
    || name.startsWith(EGRESS_BLOB_SCRATCH_PREFIX));

/** Remove every stranded archive/egress scratch file in `dataPath`, returning
 *  how many went. Unconditional rather than age-gated: the caller runs it at
 *  boot behind the instance-lock claim, so no export or restore of ours is in
 *  flight, and an age window would let plaintext from a crash-restart sit until
 *  a boot that may be months away. Best-effort throughout — a missing data dir
 *  or an unremovable file is never worth failing a boot over. */
export const sweepArchiveScratch = (dataPath: string): number => {
  let names: string[];
  try {
    names = readdirSync(dataPath);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isArchiveScratchName(name)) continue;
    try {
      unlinkSync(join(dataPath, name));
      removed += 1;
    } catch {
      /* already gone, or not ours to remove */
    }
  }
  return removed;
};

/** Backward-compatible name for existing callers. New code should use the
 *  broader name: the sweep now owns database-image scratch as well as blobs. */
export const sweepBlobScratch = sweepArchiveScratch;
