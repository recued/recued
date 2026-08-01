/** D-217 slice 0 — stage a warehouse file's plaintext once, then read it in
 *  RANGES.
 *
 *  ⚠ **The obvious signature does not work, and this is the slice's finding.**
 *  D-217 § 9 called for `readFileRange(record_id, offset, length)` beside the
 *  whole-file dep. Built that way it would decrypt the ENTIRE blob on every
 *  call: a 512 MB video at 5 MB chunks is 103 calls, i.e. ~52 GB of AES work
 *  and 103 full-size buffers, to send 512 MB. The primitive has to be
 *  **stage-once / read-many**, so it is a HANDLE, not a function.
 *
 *  ⚠ **And a ranged read cannot come from the blob store directly.** Under
 *  D-212 every blob is whole-file AES-256-GCM, and `BlobStore.getStream` is
 *  documented as *"NOT supported in encryption mode: a streaming GCM decrypt
 *  would have to EMIT plaintext chunks before the trailing auth tag is verified
 *  at `final()`, so a consumer could act on unverified bytes"*. That refusal is
 *  a safety property, not a gap — so the only correct shape is the one the
 *  archive export already uses: `decryptToFile` to a data-dir scratch file
 *  (tag verified before any byte is usable), then read ranges out of THAT.
 *
 *  Consequences the caller inherits:
 *   - a file's plaintext sits on disk for the life of the upload. It is
 *     `0o600`, its name carries no blob hash, it is unlinked in `dispose()`,
 *     and — because a `finally` cannot run after SIGKILL — its prefix is
 *     registered with `archive-scratch.ts` so the BOOT SWEEP reaps it. A new
 *     writer that mints its own path would be invisible to that sweep.
 *   - `dispose()` is not optional and not best-effort housekeeping. Call it in
 *     a `finally`.
 *
 *  The content pin (`expect_sha256`) is verified over the staged plaintext
 *  BEFORE the handle is returned, in one streaming pass. That matters for
 *  D-217's fail-closed ruling: a swapped CAS carrier is caught before the first
 *  byte leaves, rather than after the last one already has.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FileHandle } from 'node:fs/promises';

import { egressBlobScratchPath } from '../../archive/archive-scratch.js';
import type { BlobStore } from '../../storage/blob-store.js';

/** Same mode the blob store publishes its own objects with. */
const SCRATCH_MODE = 0o600;

/** An open, verified plaintext staging file. Read ranges from it, then dispose. */
export interface StagedPlaintext {
  /** Plaintext length. The chunk plan is computed from this. */
  readonly size_bytes: number;
  readonly mime_type: string;
  readonly filename: string;
  /** Read exactly `length` bytes at `offset`. Peak memory is `length`, never
   *  the whole file. Refuses a range that is not fully inside the file — a
   *  short read at the tail would produce a truncated upload the target would
   *  accept and store. */
  read(offset: number, length: number): Promise<Buffer>;
  /** Close the handle and unlink the staging file. Idempotent. MUST be called
   *  in a `finally` — the boot sweep is the backstop for a hard kill, not a
   *  substitute for this. */
  dispose(): Promise<void>;
}

/** The blob-store surface staging needs. Narrowed so a test can supply a fake
 *  without implementing the whole store. */
export type StagingBlobStore =
  Pick<BlobStore, 'get' | 'sizeOf'>
  & Partial<Pick<BlobStore, 'getStream' | 'decryptToFile' | 'plaintextSizeOf'>>
  & { readonly encrypted?: boolean };

export interface StagePlaintextArgs {
  blobs: StagingBlobStore;
  /** Where scratch lives — the server data dir, the same one the boot sweep
   *  walks. */
  dataPath: string;
  blob_hash: string;
  mime_type: string;
  filename: string;
  /** D-216 § 5.2 content pin. When present, the staged plaintext must hash to
   *  it or staging fails and the file is removed. */
  expect_sha256?: string;
  /** Refuse before staging when the plaintext is larger than this. Checked
   *  against `plaintextSizeOf` — i.e. WITHOUT decrypting — so an oversize file
   *  costs no AES work and no disk. */
  max_bytes?: number;
}

export const stagePlaintext = async (
  args: StagePlaintextArgs,
): Promise<StagedPlaintext> => {
  const { blobs, blob_hash } = args;

  // Size first, and from the metadata path: `plaintextSizeOf` subtracts the
  // AEAD envelope without touching the ciphertext, so an over-cap file is
  // refused before anything is decrypted or written.
  const declared = blobs.plaintextSizeOf !== undefined
    ? await blobs.plaintextSizeOf(blob_hash)
    : await blobs.sizeOf(blob_hash);
  if (declared === null) {
    throw new Error(`staged-plaintext: CAS blob missing for hash '${blob_hash}'`);
  }
  if (args.max_bytes !== undefined && declared > args.max_bytes) {
    throw new Error(
      `staged-plaintext: blob '${blob_hash}' is ${declared} bytes, over the ${args.max_bytes}-byte cap`,
    );
  }

  const path = egressBlobScratchPath(args.dataPath);
  let handle: FileHandle | null = null;
  let disposed = false;

  const removeFile = async (): Promise<void> => {
    try {
      await unlink(path);
    } catch {
      /* already gone — the boot sweep is the backstop */
    }
  };

  try {
    if (blobs.encrypted === true) {
      if (blobs.decryptToFile === undefined) {
        throw new Error(
          'staged-plaintext: encrypted blob store lacks decryptToFile — a ranged read cannot be served from a GCM blob without it',
        );
      }
      // Verifies the GCM tag before resolving, and removes `path` itself on a
      // tag failure. Nothing below consumes the file until this returns.
      await blobs.decryptToFile(blob_hash, path);
    } else if (blobs.getStream !== undefined) {
      const source = await blobs.getStream(blob_hash);
      if (source === null) {
        throw new Error(`staged-plaintext: CAS blob missing for hash '${blob_hash}'`);
      }
      await pipeline(source, createWriteStream(path, { mode: SCRATCH_MODE }));
    } else {
      // Last resort for a store with neither capability (in-memory fakes). This
      // DOES buffer the whole blob, so it is only reachable where `getStream`
      // is absent — never on the production keyless factory, which implements
      // it. Kept so a narrow test double does not have to fake a stream.
      const whole = await blobs.get(blob_hash);
      if (whole === null) {
        throw new Error(`staged-plaintext: CAS blob missing for hash '${blob_hash}'`);
      }
      await pipeline([whole], createWriteStream(path, { mode: SCRATCH_MODE }));
    }

    // Verify the pin over what actually landed, in one streaming pass, BEFORE
    // the handle escapes. Fail-closed (D-217 § 8c) is only meaningful if the
    // check happens here: after the walk starts, a mismatch means bytes have
    // already reached a third party.
    if (args.expect_sha256 !== undefined) {
      const hash = createHash('sha256');
      await pipeline(createReadStream(path), hash);
      const actual = hash.digest('hex');
      if (actual !== args.expect_sha256) {
        throw new Error(
          `staged-plaintext: content pin mismatch for blob '${blob_hash}' (expected ${args.expect_sha256}, got ${actual})`,
        );
      }
    }

    handle = await open(path, 'r');
    // Trust the file, not the metadata: `plaintextSizeOf` is arithmetic over
    // the on-disk envelope, and a mismatch here would silently shorten or
    // over-run the chunk plan.
    const stat = await handle.stat();
    const size_bytes = stat.size;
    if (size_bytes !== declared) {
      throw new Error(
        `staged-plaintext: staged ${size_bytes} bytes for blob '${blob_hash}' but the store declared ${declared}`,
      );
    }

    const openHandle = handle;
    return {
      size_bytes,
      mime_type: args.mime_type,
      filename: args.filename,
      read: async (offset: number, length: number): Promise<Buffer> => {
        if (disposed) {
          throw new Error('staged-plaintext: read after dispose');
        }
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new Error(`staged-plaintext: offset ${offset} is not a non-negative safe integer`);
        }
        if (!Number.isSafeInteger(length) || length <= 0) {
          throw new Error(`staged-plaintext: length ${length} is not a positive safe integer`);
        }
        if (offset + length > size_bytes) {
          throw new Error(
            `staged-plaintext: range [${offset}, ${offset + length}) runs past the ${size_bytes}-byte file`,
          );
        }
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await openHandle.read(buf, 0, length, offset);
        if (bytesRead !== length) {
          // A short read inside a bounds-checked range means the file changed
          // under us. Refuse rather than send a partial chunk.
          throw new Error(
            `staged-plaintext: short read at ${offset} (wanted ${length}, got ${bytesRead})`,
          );
        }
        return buf;
      },
      dispose: async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        try {
          await openHandle.close();
        } catch {
          /* already closed */
        }
        await removeFile();
      },
    };
  } catch (err) {
    // Any failure leaves NO plaintext behind. `decryptToFile` removes its own
    // destination on a tag failure; every other path is covered here.
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* nothing to close */
      }
    }
    await removeFile();
    throw err;
  }
};
