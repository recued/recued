/** D-149 P7 § A.5.4 — drop_link blob filesystem writer.
 *
 *  Spec § A.5.4 lines 821-827:
 *
 *    > Drop handler streams blob to disk + writes
 *    > `reception_drop_blob_metadata` row + returns success. The
 *    > `data.file` entity creation runs via reactive trigger on the new
 *    > row (NOT inline).
 *
 *  This module owns:
 *
 *    1. Streaming the multipart-borne blob to a temp file under
 *       `drop_blobs/_tmp/<uuid>` while computing sha256 + size + magic-
 *       byte signature.
 *    2. Magic-byte detection — verifies the bytes match the visitor-
 *       reported MIME type against the substrate's closed allowlist;
 *       mismatch tags the row `'rejected_mime'`.
 *    3. Filename sanitization (path-traversal defense per spec
 *       § A.5.4 line 825 + § T-16): UTF-8 normalize → remove `..` and
 *       path separators → length cap (255 bytes). Storage path is
 *       content-hash-keyed (sha256-based), NOT filename-keyed, so two
 *       visitors uploading the same filename don't collide; the
 *       sanitized name lives on the metadata row only.
 *    4. CAS write into the shared BlobStore after the temp stream is
 *       complete. The dispatcher writes the row AFTER `BlobStore.put`
 *       succeeds so an interrupted upload never leaves a metadata row
 *       pointing at a missing blob.
 *    5. Disk-fill guard (§ A.5.4 line 1733 + § T-4): the substrate
 *       imposes the per-config `size_cap_bytes` ceiling at body-stream
 *       parse so a partial file never lands. The actual disk-full
 *       failure case (95% partition fill) is detected via fs.statvfs
 *       in the handler before stream consumption begins.
 *
 *  Pure(ish) module — no SQL; the filesystem + BlobStore are the only
 *  external surfaces. Tests drive against tmp directories.
 *
 *  Spec: D-149 § A.5.4 + § Must Hold I-7. */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DROP_LINK_ALLOWED_MIME_TYPE_SET,
  DROP_LINK_VISITOR_FILENAME_MAX,
  type DropLinkAllowedMimeType,
} from '@recued/contracts';
import type { BlobStore } from '../../storage/blob-store.js';

/** Standard drop_blobs scratch subtree. The handler resolves the
 *  absolute path against the substrate's data dir at boot; successful
 *  uploads persist the CAS hash on the metadata row. */
export const DROP_BLOBS_TMP_SUBDIR = '_tmp' as const;

/** Magic-byte signature catalog. Adding a new MIME = substrate code
 *  change; aligned with `DROP_LINK_ALLOWED_MIME_TYPES`. Each entry's
 *  predicate runs against the head bytes captured from the stream. */
interface MagicSignature {
  readonly mime: DropLinkAllowedMimeType;
  readonly match: (head: Buffer) => boolean;
}

const startsWith = (buf: Buffer, bytes: number[]): boolean => {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
};

/** Closed-list magic-byte catalog. Aligned with
 *  `DROP_LINK_ALLOWED_MIME_TYPES`. Order matters — first match wins;
 *  unambiguous prefixes come first. */
const MAGIC_SIGNATURES: ReadonlyArray<MagicSignature> = [
  // PDF — `%PDF-`
  { mime: 'application/pdf', match: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  // JPEG — `FF D8 FF`
  { mime: 'image/jpeg', match: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  // PNG — `89 50 4E 47 0D 0A 1A 0A`
  {
    mime: 'image/png',
    match: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  // WEBP — `RIFF` then `WEBP` at offset 8
  {
    mime: 'image/webp',
    match: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
      b.length >= 12 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  // GIF — `GIF87a` or `GIF89a`
  {
    mime: 'image/gif',
    match: (b) =>
      startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  },
];

/** Detect the underlying MIME from the first 16+ bytes. Returns the
 *  matched type, or `'text/plain'` when no binary signature matches
 *  AND the head bytes look like UTF-8 / ASCII text (no NUL / control
 *  bytes outside `\t\r\n`). Returns `null` when nothing fits — the
 *  handler treats this as a magic-mismatch. */
export const detectMagicBytes = (head: Buffer): DropLinkAllowedMimeType | null => {
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.match(head)) return sig.mime;
  }
  // Plain-text fallback — substrate accepts ASCII / UTF-8 with no
  // control-byte pollution. Heuristic: no NUL bytes, no high-bit
  // controls. Empty buffer is permitted (zero-byte text file).
  if (head.length === 0) return 'text/plain';
  for (const b of head) {
    if (b === 0x00) return null;
    if (b < 0x09) return null;
    if (b === 0x0b || b === 0x0c) return null;
    if (b > 0x0d && b < 0x20) return null;
  }
  return 'text/plain';
};

/** Sanitize a visitor-supplied filename. Returns the sanitized name (≤
 *  `DROP_LINK_VISITOR_FILENAME_MAX` bytes) or `null` when nothing
 *  recoverable remains. Per spec § A.5.4 line 825 + § T-16 path
 *  traversal defense. */
export const sanitizeFilename = (raw: string): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // 1. UTF-8 NFC normalize.
  let s = raw.normalize('NFC');
  // 2. Strip any path component — keep only the basename.
  //    `\` (Windows) + `/` (POSIX) treated identically.
  const segments = s.split(/[\\/]/);
  s = segments[segments.length - 1] ?? '';
  // 3. Reject any `..` segment after the basename strip — defense in
  //    depth in case the filename was already a single segment with
  //    embedded `..`. The basename strip above handles `../foo`; this
  //    catches `foo..bar` style probes after we re-allow them; the
  //    closed set here is `..` alone.
  if (s === '..' || s === '.') return null;
  // 4. Strip NUL bytes + control bytes.
  s = s.replace(/[\x00-\x1f\x7f]/g, '');
  // 5. Collapse whitespace runs to single space.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;
  // 6. Length cap — UTF-8 byte length, not JS string length.
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes > DROP_LINK_VISITOR_FILENAME_MAX) {
    // Truncate to the byte boundary; preserve extension when reasonable.
    const dotIdx = s.lastIndexOf('.');
    const ext = dotIdx > 0 && s.length - dotIdx <= 16 ? s.slice(dotIdx) : '';
    const extBytes = Buffer.byteLength(ext, 'utf8');
    const room = DROP_LINK_VISITOR_FILENAME_MAX - extBytes;
    if (room <= 0) {
      // Extension alone exceeds cap — fallback to truncated head.
      const buf = Buffer.from(s, 'utf8').slice(0, DROP_LINK_VISITOR_FILENAME_MAX);
      s = buf.toString('utf8');
    } else {
      const head = s.slice(0, dotIdx > 0 ? dotIdx : s.length);
      const headBuf = Buffer.from(head, 'utf8').slice(0, room);
      s = headBuf.toString('utf8') + ext;
    }
  }
  return s.length > 0 ? s : null;
};

/** Result of a streamed blob write. */
export interface BlobWriteResult {
  /** sha256 (hex) of the uploaded bytes. */
  readonly content_hash: string;
  /** Total bytes written. */
  readonly size_bytes: number;
  /** CAS hash stored on reception_drop_blob_metadata.storage_path. */
  readonly relative_path: string;
  /** Server-detected MIME (closed-allowlist) or `null` when no
   *  signature matched. */
  readonly mime_detected: DropLinkAllowedMimeType | null;
  /** First 16 bytes of the stream — handy for the substrate's debug
   *  log entry when the detector returns null. */
  readonly head_bytes: Buffer;
}

export interface BlobWriteOptions {
  readonly drop_blobs_root: string;
  readonly blobs: BlobStore;
  readonly size_cap_bytes: number;
  /** Legacy testing hook retained for call-site stability. CAS writes
   *  are content-addressed and do not date-bucket by wallclock. */
  readonly now?: number;
}

/** Stream the blob from `source` into drop_blobs scratch, then CAS-put it.
 *
 *  Failure modes:
 *
 *    - Stream exceeds `size_cap_bytes` → throws `Error('size_cap_exceeded')`
 *      after closing the temp file + unlinking. The caller's catch
 *      blocks the row write + returns 413 to the visitor.
 *    - Stream errors → propagate; the temp file is unlinked best-effort.
 *
 *  The scratch file is removed after the CAS write, so reads-by-hash
 *  either succeed against a complete BlobStore object or 404. */
export const writeDropBlobStream = async (
  source: Readable,
  options: BlobWriteOptions,
): Promise<BlobWriteResult> => {
  const tmpDir = join(options.drop_blobs_root, DROP_BLOBS_TMP_SUBDIR);
  // The scratch carries the visitor's file in PLAINTEXT until the CAS write
  // encrypts it, on the same volume as the encrypted database. Node's defaults
  // (0777 / 0666 & umask) would leave the tree traversable and the streaming
  // file readable by every local account, so both are created owner-only.
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });

  const tmpName = randomUUID();
  const tmpPath = join(tmpDir, tmpName);

  const hash = createHash('sha256');
  let size = 0;
  let head: Buffer = Buffer.alloc(0);
  const HEAD_CAPTURE_BYTES = 16;

  const out = createWriteStream(tmpPath, { mode: 0o600 });
  let writeError: Error | null = null;
  let aborted = false;
  const cleanupTmp = async (): Promise<void> => {
    try {
      await unlink(tmpPath);
    } catch {
      /* swallow — best effort */
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      source.on('data', (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > options.size_cap_bytes) {
          aborted = true;
          writeError = new Error('size_cap_exceeded');
          source.removeAllListeners('data');
          out.destroy();
          reject(writeError);
          return;
        }
        if (head.length < HEAD_CAPTURE_BYTES) {
          const need = HEAD_CAPTURE_BYTES - head.length;
          head = Buffer.concat([head, chunk.slice(0, need)]);
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          source.pause();
          out.once('drain', () => source.resume());
        }
      });
      source.on('end', () => {
        if (aborted) return;
        out.end(() => resolve());
      });
      source.on('error', (err) => {
        if (aborted) return;
        aborted = true;
        writeError = err instanceof Error ? err : new Error(String(err));
        out.destroy();
        reject(writeError);
      });
      out.on('error', (err) => {
        if (aborted) return;
        aborted = true;
        writeError = err instanceof Error ? err : new Error(String(err));
        reject(writeError);
      });
    });
  } catch (err) {
    await cleanupTmp();
    throw err;
  }

  const content_hash = hash.digest('hex');
  try {
    // Stream the scratch temp into the CAS via putFile — never load the whole
    // (up to DROP_LINK_SIZE_CAP_HARD_MAX_BYTES = 1 GB) file into memory. The old
    // readFile + put(buffer) spiked RAM to the full file size at write time, so a
    // large drop could OOM a small server even though receipt was streamed.
    // putFile re-hashes + GCM-encrypts in chunks (peak = one chunk); the
    // independent re-hash also re-verifies the temp wasn't corrupted between
    // receipt and CAS write (preserving the old put()-hash mismatch guard).
    if (!options.blobs.putFile) {
      throw new Error('drop_blob_putfile_unsupported');
    }
    const blob_hash = await options.blobs.putFile(tmpPath);
    if (blob_hash !== content_hash) {
      throw new Error('drop_blob_cas_hash_mismatch');
    }
    await cleanupTmp();
    return {
      content_hash,
      size_bytes: size,
      relative_path: blob_hash,
      mime_detected: detectMagicBytes(head),
      head_bytes: head,
    };
  } catch (err) {
    await cleanupTmp();
    throw err;
  }
};
