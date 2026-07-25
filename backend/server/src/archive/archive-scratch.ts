/** Decrypted-blob scratch files in the server data dir, and the boot sweep that
 *  reclaims the ones a hard kill stranded.
 *
 *  Export and restore both have to land a blob's PLAINTEXT on disk for a moment
 *  — export decrypts a CAS object to a scratch file so a GB-scale attachment
 *  never buffers in RAM, restore streams the archive's plaintext to a temp file
 *  so `putFile` can content-address it. Both unlink in a `finally`, which covers
 *  every ordinary failure but cannot run after SIGKILL, an OOM kill, or power
 *  loss. What survives is warehouse plaintext on a disk whose whole point is to
 *  hold ciphertext, so it needs an owner at the next boot.
 *
 *  `BlobStore.sweepOrphans` does not reach these: it reaps `.tmp-` files INSIDE
 *  the CAS shard directories, and these sit in the data dir root.
 *
 *  Both names are built here so the sweep's pattern cannot drift from what the
 *  writers actually produce.
 */

import { randomBytes } from 'node:crypto';
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Export's per-blob scratch: `<dataPath>/.decrypt-<hash>-<nonce>.tmp`. */
export const EXPORT_BLOB_SCRATCH_PREFIX = '.decrypt-';

/** Restore's per-blob staging file: `<dataPath>/.restore-blob-<nonce>.tmp`. */
export const RESTORE_BLOB_SCRATCH_PREFIX = '.restore-blob-';

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

const isBlobScratchName = (name: string): boolean =>
  name.endsWith(BLOB_SCRATCH_SUFFIX)
  && (name.startsWith(EXPORT_BLOB_SCRATCH_PREFIX)
    || name.startsWith(RESTORE_BLOB_SCRATCH_PREFIX));

/** Remove every stranded blob scratch file in `dataPath`, returning how many
 *  went. Unconditional rather than age-gated: the caller runs it at boot behind
 *  the instance-lock claim, so no export or restore of ours is in flight, and an
 *  age window would let plaintext from a crash-restart sit until a boot that may
 *  be months away. Best-effort throughout — a missing data dir or an unremovable
 *  file is never worth failing a boot over. */
export const sweepBlobScratch = (dataPath: string): number => {
  let names: string[];
  try {
    names = readdirSync(dataPath);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isBlobScratchName(name)) continue;
    try {
      unlinkSync(join(dataPath, name));
      removed += 1;
    } catch {
      /* already gone, or not ours to remove */
    }
  }
  return removed;
};
