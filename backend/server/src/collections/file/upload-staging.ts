/** D-217 slice 2b-ii — the staging registry a chunked upload reads through.
 *
 *  Slice 0 gave us a HANDLE: stage a warehouse file's plaintext once, then read
 *  ranges out of it. This is the piece that makes that handle addressable from
 *  the two places a chunk walk touches, without either of them holding the
 *  handle itself:
 *
 *    engine  (`ExecutionContext.uploadStaging`) — stages once, disposes once.
 *    adapter (`ConnectionApiHandlerDeps.readUploadChunk`) — reads one range per
 *            APPEND.
 *
 *  🔑 **Why a token registry rather than passing the handle around.** The two
 *  sides are separated by a WIRE: the engine builds a dispatch input and the
 *  connection adapter receives it. Whatever the engine wants the adapter to
 *  send has to survive that crossing as plain data — and a chunk's BYTES must
 *  not, because the commit gateway persists a dispatch's input as the commit's
 *  `args` (`pending.args = input`, then `writePending`) and hashes it for the
 *  action identity. Literal bytes there would write the owner's file into the
 *  durable commit log once per APPEND. So the token crosses and the bytes stay
 *  here — the outbound twin of the byte-stripping D-172 already requires of
 *  `response_capture` inbound.
 *
 *  ⚠ **A token is a CAPABILITY over decrypted warehouse plaintext.** It is
 *  unguessable, it is engine-owned (the gateway strips the `__cu_` wire prefix
 *  from recipe args, and a manifest phase may not name it either), and it dies
 *  with `dispose`. An expired or unknown token reads nothing — the registry
 *  fails closed rather than falling back to any other file.
 *
 *  ⚠ **Staging costs DISK, not memory**, and that is the resource this bounds.
 *  Each entry is up to the chunked ceiling (512 MB) of plaintext in the data
 *  dir. `MAX_CONCURRENT_STAGED` refuses the (N+1)th rather than letting
 *  concurrent uploads fill the volume; refusing to stage means the walk never
 *  starts, so no bytes leave — the fail-closed direction.
 */

import { randomBytes } from 'node:crypto';

import { stagePlaintext, type StagedPlaintext, type StagingBlobStore } from './staged-plaintext.js';
import type { InboundFileCollection } from './inbound-file-collection.js';

/** How many uploads may hold staged plaintext at once. Each is bounded by the
 *  D-217 ceiling, so this is the multiplier on the worst-case disk footprint.
 *  Four concurrent 512 MB uploads is already 2 GB of scratch; more than that is
 *  a disk-exhaustion vector dressed as throughput. */
export const MAX_CONCURRENT_STAGED = 4;

export interface UploadStagingRegistry {
  /** Stage one warehouse file's plaintext and return the token addressing it.
   *  The content pin is verified before the token exists, so a swapped CAS
   *  carrier is caught before the first byte leaves (D-217 § 8.2). */
  stage(input: {
    file_ref: string;
    expect_sha256?: string;
    max_bytes: number;
  }): Promise<{ token: string; size_bytes: number; mime_type: string; filename: string }>;
  /** Read one chunk. Throws on an unknown / disposed token — never falls back
   *  to another entry, and never opens a path of its own. */
  read(
    token: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; mime_type: string }>;
  /** Close and unlink. Idempotent, so a `finally` that races a failure path is
   *  safe. */
  dispose(token: string): Promise<void>;
  /** Every live entry — for shutdown. The boot sweep reaps what a SIGKILL
   *  strands; this covers an orderly stop. */
  disposeAll(): Promise<void>;
  /** Live entry count. Test + diagnostics surface; a leak shows up here. */
  size(): number;
}

export interface CreateUploadStagingRegistryOptions {
  blobs: StagingBlobStore;
  /** The server data dir — the same one the boot sweep walks. */
  dataPath: string;
  /** Resolves a `file_ref` to the CAS carrier + its hot fields. Metadata only:
   *  staging reads the blob itself, so this must not pull bytes into memory. */
  files: Pick<InboundFileCollection, 'get'>;
}

export const createUploadStagingRegistry = (
  opts: CreateUploadStagingRegistryOptions,
): UploadStagingRegistry => {
  const live = new Map<string, StagedPlaintext>();

  return {
    async stage(input) {
      if (live.size >= MAX_CONCURRENT_STAGED) {
        throw new Error(
          `upload-staging: ${live.size} uploads are already staged (max ${MAX_CONCURRENT_STAGED}) — refusing to stage another`,
        );
      }
      const record = opts.files.get(input.file_ref);
      if (record === null) {
        throw new Error(`upload-staging: unknown file_ref '${input.file_ref}'`);
      }
      if (record.storage_ref.kind !== 'cas') {
        throw new Error(
          `upload-staging: file_ref '${input.file_ref}' is not a CAS blob — a mirrored provider file has no local plaintext to stage`,
        );
      }
      const handle = await stagePlaintext({
        blobs: opts.blobs,
        dataPath: opts.dataPath,
        blob_hash: record.storage_ref.blob_hash,
        mime_type: record.hot_fields.mime_type,
        filename: record.hot_fields.filename,
        ...(input.expect_sha256 !== undefined ? { expect_sha256: input.expect_sha256 } : {}),
        max_bytes: input.max_bytes,
      });
      // Mint AFTER staging succeeded. A token for a handle that failed its
      // content pin would be a live capability over nothing, and the caller
      // would learn about it one dispatch later instead of now.
      const token = randomBytes(24).toString('hex');
      live.set(token, handle);
      return {
        token,
        size_bytes: handle.size_bytes,
        mime_type: handle.mime_type,
        filename: handle.filename,
      };
    },

    async read(token, offset, length) {
      const handle = live.get(token);
      if (handle === undefined) {
        throw new Error('upload-staging: unknown or disposed staging token');
      }
      const bytes = await handle.read(offset, length);
      return { bytes, mime_type: handle.mime_type };
    },

    async dispose(token) {
      const handle = live.get(token);
      if (handle === undefined) return;
      // Drop the entry FIRST. `dispose` awaits a close + an unlink, and a
      // concurrent `read` arriving in that window must not be handed a handle
      // whose file is already going away.
      live.delete(token);
      await handle.dispose();
    },

    async disposeAll() {
      const handles = [...live.values()];
      live.clear();
      await Promise.all(handles.map(async (h) => {
        try {
          await h.dispose();
        } catch {
          /* shutdown is best-effort; the boot sweep is the backstop */
        }
      }));
    },

    size: () => live.size,
  };
};
