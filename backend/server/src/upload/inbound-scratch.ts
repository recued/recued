/** Inbound-bytes scratch trees on the data volume, and the boot sweep that
 *  reclaims the ones a hard kill stranded.
 *
 *  Three inbound surfaces stage user PLAINTEXT on disk before the bytes reach
 *  the CAS: a resumable upload assembles a chunked file under `upload_blobs/`,
 *  a single-POST reception drop streams into `drop_blobs/_tmp/`, and inbound
 *  messenger media (Slack / WhatsApp / Telegram photos, voice notes, PDFs)
 *  downloads into `messenger_media_tmp/`. All three unlink in a `finally`,
 *  which covers every ordinary failure but cannot run after SIGKILL, an OOM
 *  kill, or power loss. What survives is user plaintext sitting on a disk whose
 *  whole point is to hold ciphertext, so it needs an owner at the next boot.
 *
 *  Nothing else reaches these. `BlobStore.sweepOrphans` reaps `.tmp-` files
 *  INSIDE the CAS shard directories; `archive/archive-scratch.ts` walks the
 *  data-dir root only.
 *
 *  The two single-request trees have no durable owner at all — every file in
 *  them belongs to ONE in-flight request — so at boot, before any listener is
 *  accepting, every file is residue and the sweep is unconditional.
 *
 *  The upload tree is different and must not be swept blind: a resumable
 *  session is DURABLE and survives a restart BY DESIGN (the client re-probes
 *  and resumes from the persisted offset), so a scratch there is reclaimed only
 *  when a session lookup proves no row owns it. That is the same "row-less file
 *  is always an orphan" invariant the core's own orphan backstop relies on (the
 *  row is written before the file), minus its `mtime > ttl` age gate — which
 *  exists to avoid racing a concurrent create and is unnecessary at boot, where
 *  nothing is accepting chunks yet. Dropping it is the whole point: a crash
 *  orphan is reclaimed now rather than at the earliest housekeeping cycle six
 *  hours later, and reclaim stops depending on housekeeping running at all.
 *
 *  This does NOT replace the TTL sweeper — an upload abandoned by a client that
 *  never comes back still has a live row, and only expiry retires that. */

import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { UploadSessionStore } from '../storage/upload-session-store.js';
import { DROP_BLOBS_TMP_SUBDIR } from '../ports/reception/drop-blob-storage.js';

/** Resumable-upload scratch tree — `<dataPath>/upload_blobs/<upload_id>`. */
export const UPLOAD_SCRATCH_DIRNAME = 'upload_blobs';

/** Single-POST reception drop scratch — `<dataPath>/drop_blobs/_tmp/<uuid>`. */
export const DROP_BLOB_SCRATCH_SUBPATH = join('drop_blobs', DROP_BLOBS_TMP_SUBDIR);

/** Inbound messenger media downloads — `<dataPath>/messenger_media_tmp/`.
 *  Mirrored from the path `serve/compose-listeners.ts` hands the transports as
 *  `downloadDir`; the two must name the same directory or the sweep silently
 *  reclaims nothing. */
export const MESSENGER_MEDIA_SCRATCH_DIRNAME = 'messenger_media_tmp';

/** Per-tree counts of what the boot pass reclaimed. */
export interface InboundScratchReclaim {
  readonly upload_blobs: number;
  readonly drop_blobs: number;
  readonly messenger_media: number;
}

export interface ReclaimInboundScratchOptions {
  /** Session lookup for the resumable-upload tree. A scratch whose `upload_id`
   *  still has a row is left alone so the client can resume it. ABSENT ⇒ the
   *  upload tree is skipped entirely rather than swept blind: without a way to
   *  check ownership, reclaiming would destroy live resumable state. */
  readonly uploadSessions?: Pick<UploadSessionStore, 'get'>;
}

/** Remove every file in `dir` the caller does not want kept, returning how many
 *  went. Best-effort throughout — a missing directory or an unremovable entry
 *  is never worth failing a boot over, and a subdirectory simply fails to
 *  unlink. */
const reapScratchDir = (dir: string, keep?: (name: string) => boolean): number => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (keep?.(name)) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      /* already gone, a directory, or not ours to remove */
    }
  }
  return removed;
};

/** Reclaim stranded inbound plaintext under `dataPath`. Runs at boot behind the
 *  instance-lock claim, which is what proves no request of ours is holding one
 *  of these open. */
export const reclaimInboundScratch = (
  dataPath: string,
  options: ReclaimInboundScratchOptions = {},
): InboundScratchReclaim => {
  const sessions = options.uploadSessions;
  return {
    upload_blobs: sessions
      ? reapScratchDir(join(dataPath, UPLOAD_SCRATCH_DIRNAME), (name) => sessions.get(name) !== null)
      : 0,
    drop_blobs: reapScratchDir(join(dataPath, DROP_BLOB_SCRATCH_SUBPATH)),
    messenger_media: reapScratchDir(join(dataPath, MESSENGER_MEDIA_SCRATCH_DIRNAME)),
  };
};

/** Total across the three trees — what a boot log line reports. */
export const totalInboundScratchReclaimed = (r: InboundScratchReclaim): number =>
  r.upload_blobs + r.drop_blobs + r.messenger_media;
