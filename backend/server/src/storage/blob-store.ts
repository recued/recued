/** Content-addressed filesystem blob store.
 *
 *  Large values (> 64 KB serialized) land here instead of in SQLite, to
 *  avoid head-of-line-blocking the single-writer SQLite queue with
 *  multi-megabyte writes. The SQLite cache store keeps only the hash
 *  reference; actual bytes live under {root}/objects/{hh}/{rest}.bin.
 *
 *  Dedup is automatic: same content → same hash → one file on disk.
 *  Callers that write the same blob from two cache entries share a
 *  single backing file.
 *
 *  Encryption mode (optional):
 *  When `getEncryptionKey` is provided, put() encrypts plaintext under
 *  AES-256-GCM with AAD = hex hash, and get() decrypts on read. Dedup
 *  is preserved because the hash is computed on plaintext BEFORE
 *  encryption; identical content short-circuits at the exists-check
 *  without re-running crypto.
 *
 *  Operation modes are all-or-nothing for the lifetime of the store.
 *  Mixing (some blobs encrypted, others plaintext) is not supported —
 *  operators enabling encryption on an existing store must wipe first.
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, createReadStream, createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { encrypt, decrypt } from '@recued/crypto';

export interface BlobStore {
  put(data: Buffer): Promise<string>;
  /** Streaming content-address from a source FILE — never holds the whole
   *  plaintext in memory (peak = one chunk). For inbound producers that can
   *  receive large untrusted media (messenger / mail / drop): stream the
   *  download to a temp file, then hand the path here. Two passes over the
   *  source: pass 1 hashes it (→ dedup short-circuit if already stored), pass
   *  2 stream-encrypts under the SAME AES-256-GCM/AAD=hash format `put`
   *  produces, so `get`/dedup/`sweepOrphans` are byte-for-byte unchanged.
   *  The caller owns the source temp file's lifecycle.
   *
   *  `opts.replace` forces an AUTHORITATIVE overwrite: it skips the dedup-skip
   *  and re-publishes even when a blob already sits at the hash path, via the
   *  SAME temp → atomic-rename discipline — so the existing object survives
   *  until the instant of the rename (a failure before it leaves the old blob
   *  intact, NO window where a still-referenced blob is missing). Restore uses
   *  it to overwrite a possibly torn / bit-rotted object with the archive's
   *  verified bytes. Default (omitted) dedup-skips a present blob.
   *
   *  OPTIONAL capability (interface segregation): the production
   *  `createBlobStore` always implements it, but a BlobStore that only needs
   *  in-memory `put` need not — `src_path` ingest guards on its presence. */
  putFile?(srcPath: string, opts?: { replace?: boolean }): Promise<string>;
  get(hash: string): Promise<Buffer | null>;
  /** Streaming PLAINTEXT read — peak = one chunk, never the whole blob; the
   *  streaming counterpart to `get`, for consumers that pipe a (potentially
   *  GB-scale) blob elsewhere without buffering it (the archive export streams
   *  each blob into its record cipher this way). Resolves null when the blob is
   *  absent. NOT supported in encryption mode: a streaming GCM decrypt would
   *  have to EMIT plaintext chunks before the trailing auth tag is verified at
   *  `final()`, so a consumer could act on unverified bytes — use `get` for
   *  keyed blobs (it decrypts + verifies whole-before-return). Throws in
   *  encryption mode.
   *
   *  OPTIONAL capability (interface segregation, like `putFile`): the
   *  production `createBlobStore` always implements it; an in-memory fake that
   *  only needs `get` need not. The archive export guards on its presence. */
  getStream?(hash: string): Promise<Readable | null>;
  /** Decrypt an ENCRYPTED blob's PLAINTEXT to `destPath`, streaming (peak = one
   *  chunk) and verifying the GCM tag before the write is usable — the safe
   *  counterpart to `getStream` for keyed blobs, and the exact reverse of
   *  `putFile`'s stream-encrypt. The tag is checked at `final()` AFTER the
   *  plaintext is written to `destPath`, so nothing may consume `destPath`
   *  until this resolves: on a tag failure (or any error) it deletes `destPath`
   *  and throws, so a caller that only reads the file post-resolution never
   *  sees unverified bytes. Resolves for a present, authentic blob; throws
   *  `ARCHIVE_BLOB_MISSING`-style if absent. The archive export decrypts each
   *  encrypted blob to a data-volume scratch file this way, then streams the
   *  verified scratch into its record. In KEYLESS mode there is nothing to
   *  decrypt — throws; use `getStream`.
   *
   *  OPTIONAL capability (like `putFile`/`getStream`): the production
   *  `createBlobStore` always implements it. */
  decryptToFile?(hash: string, destPath: string): Promise<void>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
  sizeOf(hash: string): Promise<number | null>;
  /** The blob's PLAINTEXT byte length — what the archive record stores. Keyless:
   *  identical to `sizeOf` (on-disk bytes are plaintext). Encrypted: `sizeOf`
   *  minus the fixed AEAD envelope (`iv || ct || tag`; ct length == plaintext
   *  length for a stream cipher), computed WITHOUT decrypting. Null when absent.
   *
   *  OPTIONAL capability (like `putFile`/`getStream`): the production
   *  `createBlobStore` always implements it; a consumer that only has `sizeOf`
   *  falls back to it (correct for keyless, where the two coincide). */
  plaintextSizeOf?(hash: string): Promise<number | null>;
  sweepOrphans(keepSet: Set<string>): Promise<number>;
  totalBytes(): Promise<number>;
  readonly root: string;
  /** True iff this store encrypts at rest (a `getEncryptionKey` was provided).
   *  Consumers that must handle plaintext (the archive export) branch on it:
   *  encrypted → `decryptToFile` to scratch; keyless (or absent) → `getStream`.
   *  OPTIONAL like the capabilities above — the production `createBlobStore`
   *  always sets it; an in-memory fake that omits it reads as keyless. */
  readonly encrypted?: boolean;
}

export interface BlobStoreOptions {
  /** When provided, blob I/O is AES-256-GCM encrypted.
   *  Returning null → store operates as locked: put/get throw.
   *  Omit the option entirely for plaintext mode. */
  getEncryptionKey?: () => Uint8Array | null;
}

const sha256Hex = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** Content-address a file by streaming it through sha256 — peak memory is one
 *  read chunk, never the whole file. Same hex digest `sha256Hex` produces over
 *  the equivalent Buffer, so a streamed `putFile` and an in-memory `put` of the
 *  same bytes land at the SAME content-addressed path (dedup holds). */
const sha256File = async (srcPath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(srcPath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
};

const pathFor = (root: string, hash: string): string =>
  join(root, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

/** Ciphertext wire format: iv (12) || encrypted body (= plaintext || tag 16) */
const IV_LEN = 12;
/** AES-256-GCM authentication tag length. The on-disk envelope adds exactly
 *  `IV_LEN + AEAD_TAG_LEN` bytes over the plaintext (GCM ciphertext length ==
 *  plaintext length), so `plaintextSizeOf` derives the plaintext size by
 *  subtraction without decrypting. */
const AEAD_TAG_LEN = 16;

/** Atomic-publish temp files (`.tmp-*`) are renamed onto the canonical path in
 *  sub-millisecond time; one stranded by a hard crash between writeFile and
 *  rename is reaped by sweepOrphans once clearly stale. The window is generous
 *  so an in-flight put's temp is never mistaken for an orphan. */
const STALE_TEMP_PREFIX = '.tmp-';
const STALE_TEMP_MS = 60 * 60 * 1000; // 1h

const packCiphertext = (iv: Uint8Array, ct: Uint8Array): Buffer => {
  const buf = Buffer.alloc(iv.length + ct.length);
  buf.set(iv, 0);
  buf.set(ct, iv.length);
  return buf;
};

const unpackCiphertext = (buf: Buffer): { iv: Uint8Array; ct: Uint8Array } => {
  if (buf.length < IV_LEN + 16) {
    throw new Error('blob-store: ciphertext too short');
  }
  return {
    iv: new Uint8Array(buf.subarray(0, IV_LEN)),
    ct: new Uint8Array(buf.subarray(IV_LEN)),
  };
};

const requireKey = (provider: () => Uint8Array | null): Uint8Array => {
  const key = provider();
  if (!key) throw new Error('blob-store: locked (no encryption key available)');
  return key;
};

export const createBlobStore = (root: string, options: BlobStoreOptions = {}): BlobStore => {
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const encryption = options.getEncryptionKey;

  return {
    root,
    encrypted: !!encryption,

    async put(data) {
      const hash = sha256Hex(data);
      const path = pathFor(root, hash);
      // Dedup: if the file already exists, don't rewrite — hash is authoritative.
      if (existsSync(path)) return hash;

      const dir = dirname(path);
      await mkdir(dir, { recursive: true });

      let payload: Buffer;
      if (encryption) {
        const key = requireKey(encryption);
        const aad = new TextEncoder().encode(hash);
        const { iv, ct } = await encrypt(key, new Uint8Array(data), aad);
        payload = packCiphertext(iv, ct);
      } else {
        payload = data;
      }

      // Atomic publish: write to a unique temp file in the SAME directory (so
      // rename(2) stays a same-filesystem metadata op, never a cross-device
      // copy), then rename it onto the content-addressed path. A crash, ENOSPC,
      // or two concurrent writers can leave at most a torn TEMP file — never a
      // torn canonical .bin that the exists-check would forever treat as
      // authoritative (and that, in encryption mode, would fail GCM auth on
      // every read). The `.tmp-` prefix + missing `.bin` suffix keeps orphans
      // invisible to sweepOrphans/totalBytes.
      const tmpPath = join(dir, `${STALE_TEMP_PREFIX}${hash.slice(2)}-${randomBytes(8).toString('hex')}`);
      try {
        await writeFile(tmpPath, payload);
        await rename(tmpPath, path);
      } catch (err) {
        // Best-effort temp cleanup; ignore if it never landed.
        await unlink(tmpPath).catch(() => {});
        // A concurrent writer may have published identical content first
        // (POSIX rename overwrites; Windows rename throws EEXIST). Same hash ⇒
        // same bytes, so an existing destination means success, not failure.
        if (existsSync(path)) return hash;
        throw err;
      }
      return hash;
    },

    async putFile(srcPath, opts = {}) {
      // Pass 1 — content-address by streaming the plaintext through sha256.
      // The hash is the dest path AND (encryption mode) the GCM AAD, so it must
      // be known before we encrypt; computing it here also lets a dedup hit
      // skip the encrypt pass entirely.
      const hash = await sha256File(srcPath);
      const path = pathFor(root, hash);
      // `replace` (restore) FORCES a re-publish even when the blob exists, to
      // overwrite a possibly-torn object; default dedup-skips a present blob.
      if (!opts.replace && existsSync(path)) return hash;

      const dir = dirname(path);
      await mkdir(dir, { recursive: true });

      // Same atomic-publish discipline as `put`: stream into a unique `.tmp-`
      // file in the SAME directory, then rename onto the canonical path. A
      // crash / ENOSPC mid-stream strands at most a temp (reaped by
      // sweepOrphans), never a torn canonical `.bin`.
      const tmpPath = join(dir, `${STALE_TEMP_PREFIX}${hash.slice(2)}-${randomBytes(8).toString('hex')}`);
      try {
        if (encryption) {
          // Pass 2 — stream-encrypt to match `put`'s exact wire format:
          // iv(12) || ciphertext || GCM tag(16), AAD = hex hash. Node's
          // createCipheriv produces the identical bytes Web Crypto's
          // `@recued/crypto.encrypt` does (which packs the tag onto the
          // ciphertext); `get` decrypts it unchanged.
          const key = requireKey(encryption);
          const iv = randomBytes(IV_LEN);
          const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
          const aad = new TextEncoder().encode(hash);
          // Mirror `encrypt`'s `aad.length > 0` guard (the hash is always
          // non-empty, but keep the format contract identical).
          if (aad.length > 0) cipher.setAAD(Buffer.from(aad));
          const encryptStream = async function* (): AsyncGenerator<Buffer> {
            yield iv;
            for await (const chunk of createReadStream(srcPath)) {
              yield cipher.update(chunk as Buffer);
            }
            const fin = cipher.final();
            if (fin.length > 0) yield fin;
            yield cipher.getAuthTag();
          };
          await pipeline(encryptStream(), createWriteStream(tmpPath));
        } else {
          // Plaintext mode — stream-copy the source into the temp.
          await pipeline(createReadStream(srcPath), createWriteStream(tmpPath));
        }
        // Publish the fully-written temp. POSIX `rename` atomically OVERWRITES
        // an existing dest (the `replace` case) with no window. We deliberately
        // NEVER unlink the canonical blob first: if the rename can't overwrite
        // (a locked dest, etc.) it throws and the EXISTING blob is left intact —
        // fail-closed, so an aborted restore never strands a still-referenced
        // blob (the dangling-reference hazard a delete-before-publish would add).
        await rename(tmpPath, path);
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        // A concurrent writer may have published identical content first
        // (same hash ⇒ same bytes) — an existing dest means success. NOT for a
        // `replace`, which intends to overwrite, not no-op on a present dest.
        if (!opts.replace && existsSync(path)) return hash;
        throw err;
      }
      return hash;
    },

    async get(hash) {
      const path = pathFor(root, hash);
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      if (!encryption) return bytes;

      const key = requireKey(encryption);
      const { iv, ct } = unpackCiphertext(bytes);
      const aad = new TextEncoder().encode(hash);
      const plaintext = await decrypt(key, { iv, ct }, aad);
      return Buffer.from(plaintext);
    },

    async getStream(hash) {
      if (encryption) {
        // A streaming GCM decrypt emits plaintext before the trailing tag is
        // verified — a consumer could act on unverified bytes. Keyed reads must
        // use `get` (whole-decrypt-then-verify). No keyed streaming reader
        // exists today; build it (with that caveat handled) when one does.
        throw new Error(
          'blob-store: getStream is not supported in encryption mode — use get() (a streaming decrypt would emit unverified plaintext before the GCM tag check)',
        );
      }
      const path = pathFor(root, hash);
      if (!existsSync(path)) return null;
      return createReadStream(path);
    },

    async decryptToFile(hash, destPath) {
      if (!encryption) {
        throw new Error(
          'blob-store: decryptToFile is only valid in encryption mode — a keyless blob is already plaintext on disk (use getStream)',
        );
      }
      const key = requireKey(encryption);
      const srcPath = pathFor(root, hash);
      let fh;
      try {
        fh = await open(srcPath, 'r');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`ARCHIVE_BLOB_MISSING: blob ${hash} referenced but not present in CAS`);
        }
        throw err;
      }
      try {
        const size = (await fh.stat()).size;
        if (size < IV_LEN + AEAD_TAG_LEN) {
          throw new Error(`blob-store: blob ${hash} ciphertext too short (${size} bytes)`);
        }
        // iv is the first IV_LEN bytes; the GCM tag is the LAST AEAD_TAG_LEN
        // bytes (both fixed-position, read directly). The ciphertext is the
        // span between — streamed, never buffered whole.
        const iv = Buffer.alloc(IV_LEN);
        const ivRead = await fh.read(iv, 0, IV_LEN, 0);
        const tag = Buffer.alloc(AEAD_TAG_LEN);
        const tagRead = await fh.read(tag, 0, AEAD_TAG_LEN, size - AEAD_TAG_LEN);
        if (ivRead.bytesRead !== IV_LEN || tagRead.bytesRead !== AEAD_TAG_LEN) {
          throw new Error(`blob-store: short read of iv/tag for blob ${hash}`);
        }

        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
        const aad = new TextEncoder().encode(hash);
        // Mirror `encrypt`'s `aad.length > 0` guard — the hash is always
        // non-empty, but keep the format contract identical to `putFile`/`get`.
        if (aad.length > 0) decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(tag);

        // Stream ONLY the ciphertext span [IV_LEN, size - AEAD_TAG_LEN) through
        // the decipher into destPath; `final()` then verifies the tag. The
        // ciphertext span is empty for a 0-byte plaintext blob (final() alone
        // authenticates it). Plaintext is written to destPath BEFORE the tag
        // check, so destPath is unusable until this resolves — the catch below
        // deletes it on a tag failure so no caller ever reads unverified bytes.
        const ctStart = IV_LEN;
        const ctEndInclusive = size - AEAD_TAG_LEN - 1;
        const decryptGen = async function* (): AsyncGenerator<Buffer> {
          if (ctEndInclusive >= ctStart) {
            for await (const chunk of createReadStream(srcPath, { start: ctStart, end: ctEndInclusive })) {
              const pt = decipher.update(chunk as Buffer);
              if (pt.length > 0) yield pt;
            }
          }
          const fin = decipher.final(); // throws on GCM tag mismatch
          if (fin.length > 0) yield fin;
        };
        await pipeline(decryptGen(), createWriteStream(destPath));
      } catch (err) {
        // Tag mismatch / torn read / write failure — never leave (possibly
        // unverified) plaintext at destPath for a consumer.
        await unlink(destPath).catch(() => {});
        throw err;
      } finally {
        await fh.close();
      }
    },

    async has(hash) {
      return existsSync(pathFor(root, hash));
    },

    async delete(hash) {
      try {
        await unlink(pathFor(root, hash));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },

    async sizeOf(hash) {
      const path = pathFor(root, hash);
      try {
        const s = await stat(path);
        return s.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async plaintextSizeOf(hash) {
      const path = pathFor(root, hash);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      if (!encryption) return size;
      // Encrypted: the on-disk envelope is iv || ct || tag with ct length ==
      // plaintext length, so the plaintext size is the file size minus the
      // fixed envelope — no decrypt needed. A file below the envelope floor is
      // corrupt; surface it rather than return a negative size.
      if (size < IV_LEN + AEAD_TAG_LEN) {
        throw new Error(`blob-store: blob ${hash} ciphertext too short (${size} bytes)`);
      }
      return size - IV_LEN - AEAD_TAG_LEN;
    },

    async sweepOrphans(keepSet) {
      const { readdir } = await import('node:fs/promises');
      const objectsDir = join(root, 'objects');
      if (!existsSync(objectsDir)) return 0;

      let deleted = 0;
      const prefixes = await readdir(objectsDir);
      for (const prefix of prefixes) {
        const prefixDir = join(objectsDir, prefix);
        let files: string[];
        try {
          files = await readdir(prefixDir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.startsWith(STALE_TEMP_PREFIX)) {
            // Abandoned partial write (crash between writeFile and rename).
            // Reap only when clearly stale so an in-flight put's temp — held
            // for sub-millisecond — is never deleted out from under its rename.
            try {
              const s = await stat(join(prefixDir, file));
              if (Date.now() - s.mtimeMs > STALE_TEMP_MS) {
                await unlink(join(prefixDir, file));
                deleted++;
              }
            } catch {
              // raced with a concurrent put's rename/cleanup — ignore
            }
            continue;
          }
          if (!file.endsWith('.bin')) continue;
          const rest = file.slice(0, -'.bin'.length);
          const hash = prefix + rest;
          if (keepSet.has(hash)) continue;
          await unlink(join(prefixDir, file));
          deleted++;
        }
      }
      return deleted;
    },

    async totalBytes() {
      const { readdir } = await import('node:fs/promises');
      const objectsDir = join(root, 'objects');
      if (!existsSync(objectsDir)) return 0;

      let total = 0;
      const prefixes = await readdir(objectsDir);
      for (const prefix of prefixes) {
        const prefixDir = join(objectsDir, prefix);
        let files: string[];
        try {
          files = await readdir(prefixDir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith('.bin')) continue;
          try {
            const s = await stat(join(prefixDir, file));
            total += s.size;
          } catch {
            // race with sweep — ignore
          }
        }
      }
      return total;
    },
  };
};
