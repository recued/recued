import { RpcError } from '@recued/contracts';
import type { TempFileRef } from '@recued/contracts';

import { readConfinedTempFile } from '../../execution/run-scratch.js';

/** D-274 — `file-read-temp` (backs `core.storage.file.read-temp`): hand a
 *  run-scoped `temp` file_ref's BYTES back to the recipe that produced it.
 *
 *  ⛔ WHY THIS IS NOT A NEW REACH, which is the only question that matters for
 *  an op that returns file bytes. `records.ts` already settled it when it
 *  admitted `csv_ref` on the same backing: *"there is no second gate because
 *  there is no gate on that backing at all, and no new reach: the only nameable
 *  files are outputs of ops THIS run already dispatched under their own
 *  grants."* A temp ref cannot name a file this run did not just create, and
 *  `assertPathUnderRunScratch` fails closed on a hand-crafted
 *  `{ backing:'temp', path:'/etc/passwd' }`.
 *
 *  ⚠ AND WHY IT EXISTS AT ALL, given `file.persist` already reads the same
 *  bytes. Persist COPIES — it ingests into CAS and returns a durable id. For a
 *  view of a file the owner keeps on disk, a copy is a cache with no
 *  invalidation: swap the photo in the folder and the stored copy silently
 *  keeps showing the old one, with nothing to reconcile it. Reading the bytes
 *  live and throwing them away with the run has no such state.
 *
 *  ⚠ THE BYTES DO ENTER RECIPE STEP STATE, which the csv-filter path exists to
 *  avoid — so this is for ONE bounded artifact a human is about to look at (a
 *  preview, not a source file), never for bulk. The ceiling below is what keeps
 *  that honest; a caller wanting a large file wants `file.persist` and a
 *  durable ref.
 */

export const FILE_READ_TEMP_INGREDIENT_SLUG = 'file-read-temp' as const;

/** Deliberately far below `FILE_PREVIEW_MAX_BYTES` (25 MB). This is the
 *  bytes-through-step-state path; the size that makes it safe is the size of a
 *  thing someone is about to look at, not the size the previewer can survive. */
export const FILE_READ_TEMP_MAX_BYTES = 2 * 1024 * 1024;

export interface FileReadTempRequest {
  ref: TempFileRef;
  run_id: string;
}

export interface FileReadTempResponse {
  bytes_b64: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
}

export const handleFileReadTemp = (
  args: FileReadTempRequest,
): FileReadTempResponse => {
  // Fails closed on an empty run_id or a path escaping the run's scratch root.
  const { bytes_b64, mime_type, filename } = readConfinedTempFile(args.ref, args.run_id);
  const size_bytes = Buffer.from(bytes_b64, 'base64').byteLength;
  if (size_bytes > FILE_READ_TEMP_MAX_BYTES) {
    throw new RpcError(
      'payload_too_large',
      `file.read-temp: ${size_bytes} bytes is past the ${FILE_READ_TEMP_MAX_BYTES}-byte ceiling — `
      + 'persist it and read the record instead',
      413,
    );
  }
  return { bytes_b64, mime_type, filename, size_bytes };
};
