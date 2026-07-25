/** Phase F (D-108) — archive export.
 *
 *  Produces a `.recued.archive` file on disk: manifest + encrypted
 *  DB + config + vault-bundle + blob records + HMAC trailer.
 *
 *  M2 streaming assembler: the archive is produced by an async generator
 *  piped straight into a `Writable` sink — nothing buffers the whole
 *  archive (no `Buffer.concat`). The db streams from its `db.backup()`
 *  temp file through a GCM record cipher, and blobs are read + encrypted +
 *  written ONE at a time. This kills the dominant OOM the old shape had —
 *  `readFileSync(wholeDb)` + every blob held in `blobEntries` + a final
 *  `Buffer.concat` of the lot (a multi-GB-in-RAM peak).
 *
 *  M-blob: each blob now STREAMS too — `BlobStore.getStream` pipes the blob
 *  through a GCM record cipher (`streamedBlobRecord`), so a single GB-scale
 *  attachment never lands in memory either. Peak is now one read chunk, no
 *  longer the largest single blob.
 *
 *  The running HMAC (`hmac.update`) still covers every emitted byte in
 *  order; the trailer is its `finalize()`. Output lands on a sibling
 *  `.partial` temp and is renamed onto `destPath` only on success, so a
 *  mid-stream failure never leaves a torn archive at the destination.
 */

import type Database from 'better-sqlite3';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AEAD_TAG_LEN,
  ARCHIVE_FORMAT_VERSION,
  BLOB_NAME_PREFIX,
  CACHE_BLOB_NAME_PREFIX,
  MEMORY_BLOB_NAME_PREFIX,
  FILE_NAMES,
  IV_LEN,
  MAGIC,
  MIN_CONSUMER_VERSION,
  SCHEMA_VERSION,
  UINT32_LEN,
  type ArchiveManifest,
} from './archive-format.js';
import {
  createArchiveHmac,
  createRecordCipher,
  deriveArchiveKeys,
  encryptRecord,
  newSalt,
} from './archive-crypto.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { listReferencedBlobHashes } from '../storage/sqlite-cache-store.js';
import { listSharedReferencedBlobHashes } from '../storage/shared-store.js';
import { listAnnotationReferencedBlobHashes } from '../storage/annotation-store.js';
import { listMemoryReferencedBlobHashes } from '../user-memory-store.js';
import {
  listCollectionReferencedBlobHashes,
  quoteSqliteIdent,
} from '../storage/collection-blob-refs.js';

// `quoteSqliteIdent` moved to `storage/collection-blob-refs` (the collection
// scan reuses it, and the eviction cascade consumes that scan without pulling
// in the archive layer). Re-exported here so existing importers of it from
// this module (`archive-runtime`) resolve unchanged.
export { quoteSqliteIdent };

/** The warehouse blob refs grouped by the CAS root that holds them (blob-
 *  encryption fix Phase 2). Each group maps to one posture-tagged export
 *  source, so the archive can carry plaintext + let restore re-encrypt under
 *  the restoring server's key. Same best-effort per-source guarding as
 *  `collectBlobHashes`. */
export interface BlobHashesByStore {
  /** KEYLESS `<data>/blobs` root — shared store (+ annotation in Phase 4). */
  keyless: string[];
  /** ENCRYPTED `<data>/cache_blobs` root — cache values + collection bodies. */
  cache: string[];
  /** ENCRYPTED `<data>/memory_blobs` root — owner-authored `user_memory` bodies. */
  memory: string[];
}

export const collectBlobHashesByStore = (db: Database.Database): BlobHashesByStore => {
  const keyless = new Set<string>();
  try { for (const h of listSharedReferencedBlobHashes(db)) keyless.add(h); } catch { /* shared store absent */ }
  try { for (const h of listAnnotationReferencedBlobHashes(db)) keyless.add(h); } catch { /* annotation table absent */ }
  const cache = new Set<string>();
  try { for (const h of listReferencedBlobHashes(db)) cache.add(h); } catch { /* cache table absent */ }
  try { for (const h of listCollectionReferencedBlobHashes(db)) cache.add(h); } catch { /* collection scan failed; skip */ }
  const memory = new Set<string>();
  try { for (const h of listMemoryReferencedBlobHashes(db)) memory.add(h); } catch { /* user_memory table absent */ }
  return { keyless: [...keyless], cache: [...cache], memory: [...memory] };
};

/** Build the posture-split export blob sources from a data dir + db. The
 *  keyless `blobs` root (shared + annotation) streams plaintext directly; the
 *  ENCRYPTED `cache_blobs` (cache + collections) + `memory_blobs` (owner memory)
 *  roots are opened with `getBlobKey` — the realm's `blob-store` sub-DEK
 *  provider — so their bodies decrypt on export. Pass `getBlobKey = undefined`
 *  for a KEYLESS server (those roots are plaintext there and read keyless) —
 *  NEVER for an encrypted server, where a keyless view would archive ciphertext.
 *  Only non-empty groups become sources. Shared by the online rpc (`runExport`,
 *  the live `KeyManager.keyProvider('blob-store')`) + the offline CLI
 *  (`cmdExport`, the key derived from the db's server bundle via
 *  `deriveBlobStoreKeyFromDb`). */
export const buildExportBlobSources = (
  dataPath: string,
  db: Database.Database,
  getBlobKey: (() => Uint8Array | null) | undefined,
): BlobSource[] => {
  const byStore = collectBlobHashesByStore(db);
  const sources: BlobSource[] = [];
  if (byStore.keyless.length > 0) {
    sources.push({
      store: createBlobStore(join(dataPath, 'blobs')),
      hashes: byStore.keyless,
      prefix: BLOB_NAME_PREFIX,
    });
  }
  if (byStore.cache.length > 0) {
    sources.push({
      store: createBlobStore(
        join(dataPath, 'cache_blobs'),
        getBlobKey ? { getEncryptionKey: getBlobKey } : {},
      ),
      hashes: byStore.cache,
      prefix: CACHE_BLOB_NAME_PREFIX,
    });
  }
  if (byStore.memory.length > 0) {
    sources.push({
      store: createBlobStore(
        join(dataPath, 'memory_blobs'),
        getBlobKey ? { getEncryptionKey: getBlobKey } : {},
      ),
      hashes: byStore.memory,
      prefix: MEMORY_BLOB_NAME_PREFIX,
    });
  }
  return sources;
};

export interface ExportOptions {
  /** Absolute path to write the archive to. Parent directory is
   *  created if it doesn't exist. Refuses to overwrite unless
   *  `force: true` is passed. */
  destPath: string;
  /** 32-byte recovery key derived from the user's recovery phrase.
   *  The same buffer the FileVault unlock path accepts. */
  recoveryKey: Buffer;
  /** Live SQLite database. Export uses `db.backup()` so writes
   *  continue safely during the dump. */
  db: Database.Database;
  /** Path to the live config.toml (usually `config.source`). Omit
   *  to skip the config record — rare, but useful for test harnesses
   *  that don't have an on-disk config. */
  configPath?: string;
  /** Vault recovery bundle JSON from the `bundle-store`. Optional
   *  for parity with test harnesses that didn't enroll FileVault. */
  vaultBundleJson?: string;
  /** A signed `migration_full` server passport, serialized JSON. When set,
   *  it rides as the `passport.json` record (the export-time "include
   *  identity passport" toggle). Omit to skip it. */
  passportJson?: string;
  /** Legacy single keyless blob source. Reference to the blob store so we can
   *  read CAS payloads; when omitted, `blobHashes` must also be empty.
   *  Equivalent to a single `blobSources` entry `{ store, hashes: blobHashes,
   *  prefix: 'blobs/' }`. Prefer `blobSources` for the posture-split roots. */
  blobs?: BlobStore;
  /** Explicit blob hashes for the legacy `blobs` source. */
  blobHashes?: string[];
  /** Blob-encryption fix Phase 2 — the posture-split blob sources. Each source
   *  pairs a store with the hashes to bundle from it and the record-name prefix
   *  that tags its posture (`blobs/` keyless, `cache-blobs/` + `memory-blobs/`
   *  encrypted). The archive ALWAYS carries plaintext: a keyless source streams
   *  directly; an encrypted source is decrypted (tag-verified) to a scratch file
   *  first. Supersedes `blobs`/`blobHashes` when present. */
  blobSources?: BlobSource[];
  /** Overwrite an existing file at `destPath`. Default: throw. */
  force?: boolean;
  /** Optional host name in the manifest. Default: `os.hostname()`. */
  sourceHost?: string;
  /** Injected salt — tests use this for deterministic output. */
  saltOverride?: Buffer;
  /** Time source — tests use this for deterministic `created_at`. */
  now?: () => number;
  /** Producer version, baked into the manifest. Caller supplies
   *  (the server already has it via `SERVER_VERSION`). */
  producerVersion: string;
}

/** One posture-tagged blob source for the export. `store.encrypted` decides how
 *  each blob's plaintext is obtained (keyless `getStream` vs. `decryptToFile`);
 *  `prefix` tags the record so restore routes it to the matching store. */
export interface BlobSource {
  store: BlobStore;
  hashes: string[];
  /** Record-name prefix, e.g. `blobs/` / `cache-blobs/` / `memory-blobs/`. */
  prefix: string;
}

export interface ExportResult {
  /** Absolute path of the written archive. */
  path: string;
  /** Archive size in bytes (including HMAC trailer). */
  bytes_written: number;
  /** Number of blob records included. */
  blob_count: number;
  /** Manifest object embedded in the archive. */
  manifest: ArchiveManifest;
}

/** Largest value the uint32 record framing can express. */
const UINT32_MAX = 0xffff_ffff;

/** Encode a length as a 4-byte big-endian uint32, REFUSING anything the
 *  framing can't hold. The previous `n >>> 0` silently wrapped, which —
 *  now that the db streams instead of being `readFileSync`'d whole (the
 *  old implicit RAM ceiling that used to throw first) — would emit a
 *  record whose advertised body length wraps while the real bytes don't,
 *  producing a "successful" but unreadable archive. Fail fast instead.
 *  Exported for the overflow-guard regression test. */
export const uint32BE = (n: number): Buffer => {
  if (!Number.isInteger(n) || n < 0 || n > UINT32_MAX) {
    throw new Error(
      `ARCHIVE_RECORD_TOO_LARGE: length ${n} exceeds the 4 GiB per-record limit of the archive format (uint32 framing)`,
    );
  }
  const b = Buffer.alloc(UINT32_LEN);
  b.writeUInt32BE(n, 0);
  return b;
};

/** Temporary SQLite backup path, sibling to the final archive. Always
 *  reclaimed in `exportArchive`'s `finally` — a full SQLite copy (possibly
 *  GBs) must never be stranded, least of all for a no-SSH user who can't
 *  delete it by hand. */
const tempDbPath = (dest: string): string => `${dest}.db.tmp`;

export const exportArchive = async (
  opts: ExportOptions,
): Promise<ExportResult> => {
  const now = opts.now?.() ?? Date.now();

  // Pre-flight: destination writable?
  if (existsSync(opts.destPath) && !opts.force) {
    throw new Error(`ARCHIVE_TARGET_UNWRITABLE: ${opts.destPath} exists (pass --force to overwrite)`);
  }
  const parent = dirname(opts.destPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // The whole assemble path — the SQLite backup, sizing, encryption, and
  // the streamed write — runs inside one try/finally so the `finally`
  // ALWAYS reclaims `dbTemp` (a full SQLite copy; GBs a no-SSH user
  // couldn't delete) on EVERY failure after the backup begins: a failing /
  // partial backup, a `statSync` race, a referenced-but-absent blob (size
  // pass OR mid-stream), an over-limit record, a write error, or a
  // post-pipeline `rename` failure. The `.partial` archive is reclaimed too
  // unless the rename committed it.
  const dbTemp = tempDbPath(opts.destPath);
  const partialPath = `${opts.destPath}.partial`;
  let committed = false;
  try {
    // 1. SQLite online backup to a temp file. The db streams straight from
    //    this file into the archive (never read whole into memory), so we
    //    only need its byte length up front for the record header.
    await opts.db.backup(dbTemp);
    const dbByteLen = statSync(dbTemp).size;

    // 2. Gather the small plaintext inputs (config / vault / passport — all
    //    KB-scale, so buffering them is fine). The db + blobs, which carry
    //    the bulk, are streamed in step 5.
    const configBytes = opts.configPath && existsSync(opts.configPath)
      ? readFileSync(opts.configPath)
      : null;
    const vaultBytes = opts.vaultBundleJson
      ? Buffer.from(opts.vaultBundleJson, 'utf8')
      : null;
    const passportBytes = opts.passportJson
      ? Buffer.from(opts.passportJson, 'utf8')
      : null;

    // Blobs: normalize to the posture-tagged sources (the legacy single
    // `blobs`/`blobHashes` maps to one keyless `blobs/` source), then size each
    // up front with a cheap stat (no content read) for the manifest and stream
    // one body at a time during assembly so the whole set never sits in RAM.
    // The archive ALWAYS stores plaintext, so the sizing figure is the
    // PLAINTEXT length (`plaintextSizeOf` — for an encrypted store that is the
    // on-disk size minus the AEAD envelope, no decrypt needed; for keyless it
    // equals `sizeOf`). A referenced-but-absent blob fails fast here, before
    // any byte is written.
    const blobSources: BlobSource[] = opts.blobSources
      ?? (opts.blobs && opts.blobHashes
        ? [{ store: opts.blobs, hashes: opts.blobHashes, prefix: BLOB_NAME_PREFIX }]
        : []);
    const blobPlan: Array<{
      store: BlobStore;
      prefix: string;
      encrypted: boolean;
      hash: string;
      plaintextLen: number;
    }> = [];
    let blobTotalBytes = 0;
    for (const source of blobSources) {
      for (const hash of source.hashes) {
        const size = source.store.plaintextSizeOf
          ? await source.store.plaintextSizeOf(hash)
          : await source.store.sizeOf(hash);
        if (size === null) {
          throw new Error(`ARCHIVE_BLOB_MISSING: blob ${hash} referenced but not present in CAS`);
        }
        blobPlan.push({
          store: source.store,
          prefix: source.prefix,
          encrypted: !!source.store.encrypted,
          hash,
          plaintextLen: size,
        });
        blobTotalBytes += size;
      }
    }

    // 3. Derive keys.
    const salt = opts.saltOverride ?? newSalt();
    const keys = deriveArchiveKeys(opts.recoveryKey, salt);
    const hmac = createArchiveHmac(keys.hmac);

    const manifest: ArchiveManifest = {
      producer_version: opts.producerVersion,
      min_consumer_version: MIN_CONSUMER_VERSION,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      schema_version: SCHEMA_VERSION,
      created_at: now,
      source_host: opts.sourceHost ?? safeHostname(),
      db_size_bytes: dbByteLen,
      blob_count: blobPlan.length,
      blob_bytes: blobTotalBytes,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: salt.toString('hex'),
        info: 'recued-archive-v1',
      },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');

    // 4. Every archive byte EXCEPT the trailer flows through `emit`, which
    //    feeds the running HMAC and returns the buffer to yield. The trailer
    //    is `hmac.finalize()` itself, so it is appended last — after the
    //    generator has produced (and HMAC'd) everything before it.
    const emit = (b: Buffer): Buffer => { hmac.update(b); return b; };

    // A buffered record (small inputs + each blob, encrypted whole via
    // `encryptRecord`). Skips entirely when the body is null.
    async function* bufferRecord(name: string, body: Buffer | null): AsyncGenerator<Buffer> {
      if (!body) return;
      const enc = encryptRecord(keys.content, body);
      const nameBuf = Buffer.from(name, 'utf8');
      yield emit(uint32BE(nameBuf.length));
      yield emit(nameBuf);
      yield emit(uint32BE(enc.length));
      yield emit(enc);
    }

    // The db record, streamed from `dbTemp` through a GCM record cipher so a
    // multi-GB backup never lands in memory. The body length is known up
    // front (iv + plaintext + tag), so its header precedes the ciphertext.
    async function* streamedDbRecord(): AsyncGenerator<Buffer> {
      const cipher = createRecordCipher(keys.content);
      const bodyLen = IV_LEN + dbByteLen + AEAD_TAG_LEN;
      const nameBuf = Buffer.from(FILE_NAMES.db, 'utf8');
      yield emit(uint32BE(nameBuf.length));
      yield emit(nameBuf);
      yield emit(uint32BE(bodyLen));
      yield emit(cipher.iv);
      for await (const chunk of createReadStream(dbTemp)) {
        const ct = cipher.update(chunk as Buffer);
        if (ct.length > 0) yield emit(ct);
      }
      yield emit(cipher.final());
    }

    // A blob record, streamed through a GCM record cipher so a GB-scale
    // attachment never lands in memory. The archive stores PLAINTEXT: a keyless
    // source streams the on-disk bytes via `getStream`; an ENCRYPTED source is
    // first decrypted (tag-verified) to a data-volume scratch file via
    // `decryptToFile`, then that verified plaintext is streamed (nothing
    // consumes it before the tag check, and the scratch is always reclaimed).
    // Same wire format `bufferRecord`/`encryptRecord` produce (name, then
    // iv‖ct‖tag). The record name carries the posture prefix so restore routes
    // it. A streamed-vs-sized mismatch throws so a torn archive is never
    // committed.
    async function* streamedBlobRecord(
      entry: (typeof blobPlan)[number],
    ): AsyncGenerator<Buffer> {
      const { store, prefix, encrypted, hash, plaintextLen } = entry;
      const cipher = createRecordCipher(keys.content);
      const bodyLen = IV_LEN + plaintextLen + AEAD_TAG_LEN;
      const nameBuf = Buffer.from(`${prefix}${hash}`, 'utf8');
      yield emit(uint32BE(nameBuf.length));
      yield emit(nameBuf);
      yield emit(uint32BE(bodyLen));
      yield emit(cipher.iv);

      // Scratch decrypt path (encrypted sources only) — a sibling temp of the
      // archive, on the same data volume, always unlinked in the `finally`.
      let scratchPath: string | undefined;
      try {
        let plaintext: Readable;
        if (encrypted) {
          if (!store.decryptToFile) {
            throw new Error('ARCHIVE_BLOB_STREAM_UNSUPPORTED: encrypted blob store lacks decryptToFile');
          }
          scratchPath = join(
            dirname(opts.destPath),
            `.decrypt-${hash}-${randomBytes(6).toString('hex')}.tmp`,
          );
          // Verifies the GCM tag before returning; throws (and removes the
          // scratch) on a tampered/absent blob, aborting the whole export.
          await store.decryptToFile(hash, scratchPath);
          plaintext = createReadStream(scratchPath);
        } else {
          if (!store.getStream) {
            throw new Error('ARCHIVE_BLOB_STREAM_UNSUPPORTED: blob store lacks getStream (streaming read required for export)');
          }
          const s = await store.getStream(hash);
          if (!s) {
            // Raced with a delete between the size pass and here.
            throw new Error(`ARCHIVE_BLOB_MISSING: blob ${hash} referenced but not present in CAS`);
          }
          plaintext = s;
        }
        let streamed = 0;
        for await (const chunk of plaintext) {
          const buf = chunk as Buffer;
          streamed += buf.length;
          const ct = cipher.update(buf);
          if (ct.length > 0) yield emit(ct);
        }
        if (streamed !== plaintextLen) {
          throw new Error(
            `ARCHIVE_BLOB_SIZE_CHANGED: blob ${hash} was ${plaintextLen} bytes at sizing but ${streamed} when streamed`,
          );
        }
        yield emit(cipher.final());
      } finally {
        if (scratchPath) await unlink(scratchPath).catch(() => { /* best-effort */ });
      }
    }

    // 5. Assemble the archive as a byte stream piped straight to disk — no
    //    whole-archive Buffer, no `Buffer.concat`. Records are written in a
    //    fixed order; the import builds a name→bytes map so order is free,
    //    and the HMAC is a running hash over the exact bytes emitted.
    async function* assemble(): AsyncGenerator<Buffer> {
      yield emit(MAGIC);
      yield emit(uint32BE(manifestBytes.length));
      yield emit(manifestBytes);

      yield* streamedDbRecord();
      yield* bufferRecord(FILE_NAMES.config, configBytes);
      yield* bufferRecord(FILE_NAMES.vault, vaultBytes);
      yield* bufferRecord(FILE_NAMES.passport, passportBytes);
      for (const entry of blobPlan) {
        yield* streamedBlobRecord(entry);
      }

      // HMAC trailer — finalize() after every prior byte has been fed.
      yield hmac.finalize();
    }

    // Write to the sibling `.partial` temp, then rename it onto `destPath`
    // so a mid-stream failure never leaves a torn archive the GC would
    // mistake for a real backup. (The `.partial` suffix is outside the
    // generated-export name pattern, so the GC ignores it regardless.)
    await pipeline(assemble(), createWriteStream(partialPath));
    await rename(partialPath, opts.destPath);
    committed = true;
    return {
      path: opts.destPath,
      bytes_written: statSync(opts.destPath).size,
      blob_count: blobPlan.length,
      manifest,
    };
  } finally {
    await unlink(dbTemp).catch(() => { /* best-effort — may already be gone */ });
    if (!committed) {
      await unlink(partialPath).catch(() => { /* never written / already gone */ });
    }
  }
};

const safeHostname = (): string | undefined => {
  try { return hostname(); } catch { return undefined; }
};
