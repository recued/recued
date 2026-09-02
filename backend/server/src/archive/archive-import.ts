/** Phase F (D-108) — archive import.
 *
 *  Inverse of export: reads the archive from disk, verifies the
 *  plaintext manifest against compatibility rules, derives keys
 *  from the supplied recovery key, streams + decrypts + verifies
 *  each record, checks the trailing HMAC, and hands the decoded
 *  plaintext to a consumer.
 *
 *  M4b.0 streaming rework: the dominant memory cost — the whole db read
 *  into a `Buffer` (`readFileSync` + the per-record decrypt) — is gone.
 *  `streamImportArchive` walks a `createReadStream` of the archive,
 *  holding back only a rolling 32-byte tail (the HMAC trailer lives at
 *  EOF) and decrypting each record body INCREMENTALLY through a GCM record
 *  decipher (`createRecordDecipher`). The decrypted bytes are pushed to a
 *  consumer as they're produced — the db + blobs stream straight to disk
 *  (restore) while the small config/vault/passport records buffer whole
 *  (KB-scale). Peak drops from the whole warehouse to one read chunk plus,
 *  for a buffering consumer, the largest single record it chooses to hold.
 *
 *  This module does NOT touch the target filesystem directly — the
 *  consumer owns where the plaintext lands. Separation keeps verification
 *  logic unit-testable without any side-effects. `importArchive` remains a
 *  convenience buffered adapter (collect-everything-into-memory) over the
 *  streaming core, for tests + small-archive previews.
 */

import { createReadStream } from 'node:fs';
import { serverBundleFromJSON } from '@recued/crypto';
import { isValidReleaseVersion } from '@recued/release';
import {
  AEAD_TAG_LEN,
  ARCHIVE_FORMAT_VERSION,
  BLOB_NAME_PREFIX,
  CACHE_BLOB_NAME_PREFIX,
  MEMORY_BLOB_NAME_PREFIX,
  FILE_NAMES,
  HMAC_LEN,
  IV_LEN,
  MAGIC,
  MAGIC_LEN,
  SCHEMA_VERSION,
  UINT32_LEN,
  type ArchiveManifest,
} from './archive-format.js';
import {
  createArchiveHmac,
  createRecordDecipher,
  deriveArchiveKeys,
  type ArchiveHmac,
  type ArchiveKeys,
  type RecordDecipher,
} from './archive-crypto.js';

export interface ImportedRecords {
  manifest: ArchiveManifest;
  db: Buffer;
  config?: Buffer;
  vault?: Buffer;
  /** D-212 dual-wrapped Master-DEK sidecar. */
  serverVault?: Buffer;
  /** Decrypted `passport.json` (a signed `migration_full` projection,
   *  serialized JSON) when the export embedded one. The M5 cross-machine
   *  migration commits provenance from this; M1 surfaces only its presence. */
  passport?: Buffer;
  blobs: Array<{ hash: string; bytes: Buffer; namespace: BlobNamespace }>;
}

export interface ImportOptions {
  /** Absolute path of the archive to read. */
  archivePath: string;
  /** 32-byte recovery key buffer. */
  recoveryKey: Buffer;
  /** Consumer version; used to check `min_consumer_version`.
   *  Caller supplies (`SERVER_VERSION`). */
  consumerVersion: string;
  /** Skip version compat check — tests or admin rescue. */
  allowFutureVersion?: boolean;
}

/** A sink for a single record's decrypted plaintext. The streaming reader
 *  feeds `write` the plaintext chunks as GCM produces them (optimistically,
 *  BEFORE the tag verifies) and calls `end` once the record's tag has
 *  authenticated. A consumer that streams to disk applies backpressure by
 *  awaiting `write`; a buffering consumer just collects the chunks. */
export interface RecordWriter {
  write(chunk: Buffer): void | Promise<void>;
  end(): void | Promise<void>;
}

/** Which CAS root a blob record restores into (blob-encryption fix Phase 3).
 *  Derived from the record-name prefix: `blobs/` (shared+annotation),
 *  `cache-blobs/` (cache+collection), `memory-blobs/` (memory). `keyless` is a
 *  historical wire-level label for `blobs/`; D-212 slice 4 routes all three to
 *  encrypted production stores. */
export type BlobNamespace = 'keyless' | 'cache' | 'memory';

/** Consumer driven by `streamImportArchive`. Records arrive in archive
 *  order (db, then config/vault/passport, then blobs). `onDb`/`onBlob`
 *  return a streaming sink for the (potentially large) body; the small
 *  named records are delivered whole via `onSmallRecord`. Unknown record
 *  names are still decrypted (to authenticate the tag + feed the HMAC) but
 *  their plaintext is discarded. */
export interface ImportConsumer {
  /** The mandatory `db.sqlite` record (first). */
  onDb(): RecordWriter | Promise<RecordWriter>;
  /** A blob record. `namespace` (from the record-name prefix) selects the
   *  target CAS root; the plaintext bytes are the same either way. */
  onBlob(hash: string, namespace: BlobNamespace): RecordWriter | Promise<RecordWriter>;
  /** A small named record: config / legacy vault / server-vault sidecar /
   *  passport. Buffered whole (KB-scale). */
  onSmallRecord?(name: string, bytes: Buffer): void | Promise<void>;
}

/** What a full streaming pass verified + measured, WITHOUT retaining the
 *  bulk records. `dbBytes` / `smallRecordBytes` are decrypted plaintext
 *  byte counts; `blobCount` is the number of blob records (already checked
 *  against `manifest.blob_count`). */
export interface ImportSummary {
  manifest: ArchiveManifest;
  dbBytes: number;
  blobCount: number;
  smallRecordBytes: Record<string, number>;
}

/** A no-op writer — decrypt the record to authenticate its tag + advance
 *  the GCM/HMAC state, but drop the plaintext. Stateless, so a single
 *  instance is safe to reuse across the sequentially-processed records of
 *  one import pass. */
export const DISCARD_RECORD_WRITER: RecordWriter = {
  write: () => { /* drop */ },
  end: () => { /* nothing */ },
};

/** Defensive ceilings on the two attacker-influenced length prefixes that
 *  the streaming parser would otherwise accumulate before the HMAC/GCM gate
 *  could reject them. (The old whole-file `readFileSync` path bounded these
 *  implicitly by the on-disk size; streaming has no such bound up front.)
 *  Both are vastly larger than any real value — the manifest is a few
 *  hundred bytes of JSON; record names are `db.sqlite` / `config.toml` /
 *  `vault-bundle.json` / `server-vault-bundle.json` / `passport.json` /
 *  `blobs/<64-hex>`. */
const MAX_MANIFEST_LEN = 4 * 1024 * 1024;
const MAX_RECORD_NAME_LEN = 4096;

/** A `small` record (config / vault / server-vault sidecar / passport) is buffered whole, so it's
 *  the one streamed-record class that could OOM a memory-flat pass on a
 *  crafted (HMAC-valid) archive. Real values are KB-scale; this generous
 *  ceiling bounds the buffer while never rejecting a legitimate record. The
 *  db (streamed to disk) + blobs (overlaid one at a time) carry the bulk and
 *  are NOT subject to it. */
const MAX_SMALL_RECORD_LEN = 64 * 1024 * 1024;

/** A blob record name is `blobs/<sha256-hex>`. Validating the suffix before
 *  it reaches the filesystem (the CAS `pathFor` builds a path from raw hash
 *  slices) closes a path-traversal vector — a crafted name like
 *  `blobs/../../victim` would otherwise address files outside the CAS. */
const BLOB_HASH_RE = /^[0-9a-f]{64}$/;

/** Match a blob record name to its posture namespace + hash (blob-encryption
 *  fix Phase 3). The three prefixes are mutually non-overlapping, so match
 *  order is irrelevant; the specific (encrypted) ones lead defensively. Returns
 *  null for a non-blob record name. */
const BLOB_RECORD_PREFIXES: ReadonlyArray<{ prefix: string; namespace: BlobNamespace }> = [
  { prefix: CACHE_BLOB_NAME_PREFIX, namespace: 'cache' },
  { prefix: MEMORY_BLOB_NAME_PREFIX, namespace: 'memory' },
  { prefix: BLOB_NAME_PREFIX, namespace: 'keyless' },
];
const matchBlobRecord = (
  name: string,
): { namespace: BlobNamespace; hash: string } | null => {
  for (const { prefix, namespace } of BLOB_RECORD_PREFIXES) {
    if (name.startsWith(prefix)) return { namespace, hash: name.slice(prefix.length) };
  }
  return null;
};

const readUint32BE = (buf: Buffer, offset: number): number => {
  if (offset + UINT32_LEN > buf.length) {
    throw new Error('ARCHIVE_TRUNCATED: uint32 read past end');
  }
  return buf.readUInt32BE(offset);
};

/** Version comparison: supports `yy.m.d[.n]` + pre-release suffixes.
 *  Returns negative when a < b, 0 when equal, positive when a > b.
 *  We don't pull in semver — this is a narrow four-segment compare.
 *
 *  ⛔⛔ THIS READ EXACTLY THREE SEGMENTS AND THEREFORE FAILED **OPEN**. D-258
 *  added the same-day hotfix `yy.m.d.n`, and a three-segment loop truncates it:
 *  a `26.9.1` server checked against an archive requiring `26.9.1.1` compared
 *  EQUAL and the restore was ACCEPTED — measured. `min_consumer_version` is a
 *  fail-CLOSED contract ("this archive needs at least this server"), so
 *  truncation inverts it precisely on the floors that exist to protect a
 *  restore, and the failure is a successful restore onto a server that cannot
 *  read the data rather than a refusal anyone sees.
 *
 *  ⚠ Latent rather than live when it was found: `MIN_CONSUMER_VERSION` is the
 *  static `'0.2.0'`, never derived from the server version, so no first-party
 *  archive carries a 4-segment floor today. The contract was still wrong, and a
 *  floor is exactly the field a future hotfix would want to raise.
 *
 *  🔑 Same ordering as `compareVersions` (packages/release + version-guard.mjs):
 *  a missing segment reads as 0, so every existing triple compares as it always
 *  did. It is NOT shared with them — this one throws on a non-numeric segment
 *  because an unreadable floor must refuse the restore, where the release
 *  comparator coerces to 0 to keep the update path total. */
const cmpVersion = (a: string, b: string): number => {
  // ⛔⛔ A SEGMENT COUNT IS PART OF THE GRAMMAR, AND SLICING IS NOT REJECTING.
  // Widening the loop from 3 to 4 fixed the truncation at the boundary that
  // existed and left the same hole one segment further out: `26.9.1.1.1` and
  // `26.9.1.1` still compared EQUAL, so an archive declaring a five-segment
  // floor was ACCEPTED by a server below it — measured. `min_consumer_version`
  // arrives from the archive FILE, which is attacker- or corruption-supplied, so
  // "whatever it says, coerced to numbers" is not a floor. Parse, or refuse.
  //
  // 🔑 The grammar is IMPORTED, not restated. `isValidReleaseVersion` is the
  // authority in `@recued/release` (which this package already depends on for
  // the update path), so the floor an archive declares is judged by exactly the
  // rule that judges a release version — including the positive-ordinal rule
  // that a bare `/^\d+$/` per segment would let `26.9.1.0` through.
  // ⛔⛔ VALIDATE THE FIELD AS SUPPLIED, NOT A VERSION DERIVED FROM IT. This
  // carried the old code's `split('-')[0]` forward and then validated the STUMP,
  // so `26.9.1-rc.1` and `26.9.1.1-rc1` were accepted by a check whose whole
  // purpose is to reject what the canonical grammar rejects — the strip handed
  // the validator a different string than the one being compared. Nothing needs
  // the suffix tolerance: `MIN_CONSUMER_VERSION` is a plain triple and the
  // consumer version is this server's own, which the grammar already governs.
  //
  // 🔑 A validator that normalises its input first is answering about the
  // normalised value. `min_consumer_version` arrives from the archive FILE, so
  // the value judged must be the value used.
  const parse = (v: string): number[] => {
    if (!isValidReleaseVersion(v)) {
      throw new Error(
        `ARCHIVE_FUTURE_VERSION: '${v}' is not a version — expected yy.m.d or yy.m.d.n`,
      );
    }
    return v.split('.').map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
};

/** Parse + validate the plaintext manifest before touching any
 *  ciphertext. Returns the accepted manifest or throws with a
 *  `code`-style error message the CLI translates to exit codes. */
export const parseManifest = (
  archive: Buffer,
): { manifest: ArchiveManifest; manifestBytes: Buffer; offsetAfter: number } => {
  if (archive.length < MAGIC_LEN + UINT32_LEN) {
    throw new Error('ARCHIVE_TRUNCATED: header too short');
  }
  if (!archive.subarray(0, MAGIC_LEN).equals(MAGIC)) {
    throw new Error('ARCHIVE_INVALID: magic mismatch');
  }
  const manifestLen = readUint32BE(archive, MAGIC_LEN);
  const manifestStart = MAGIC_LEN + UINT32_LEN;
  const manifestEnd = manifestStart + manifestLen;
  if (manifestEnd > archive.length) {
    throw new Error('ARCHIVE_TRUNCATED: manifest length exceeds file');
  }
  const manifestBytes = archive.subarray(manifestStart, manifestEnd);
  let parsed: ArchiveManifest;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8')) as ArchiveManifest;
  } catch (err) {
    throw new Error(`ARCHIVE_INVALID: manifest JSON parse: ${(err as Error).message}`);
  }
  return { manifest: parsed, manifestBytes, offsetAfter: manifestEnd };
};

/** M5 S3.0 — is the archive's db SCHEMA newer than THIS binary understands?
 *  `min_consumer_version` is a static floor + `archive_format_version` tracks
 *  only the on-disk envelope, so neither catches a db-schema bump; this compares
 *  the manifest's `schema_version` against the binary's `SCHEMA_VERSION` directly.
 *  An OLDER/equal archive is fine — the newer binary's idempotent boot DDL
 *  applies the additive schema forward on the post-restore restart; only a NEWER
 *  archive (made by a newer Recued) is unrestorable here (no downgrade path). */
export const archiveSchemaTooNew = (schemaVersion: number): boolean =>
  schemaVersion > SCHEMA_VERSION;

/** Check manifest version compatibility. */
export const checkManifestCompat = (
  manifest: ArchiveManifest,
  consumerVersion: string,
  allowFutureVersion: boolean,
): void => {
  if (manifest.archive_format_version > ARCHIVE_FORMAT_VERSION) {
    if (!allowFutureVersion) {
      throw new Error(
        `ARCHIVE_FUTURE_VERSION: archive_format_version ${manifest.archive_format_version} > ${ARCHIVE_FORMAT_VERSION}`,
      );
    }
  }
  if (cmpVersion(consumerVersion, manifest.min_consumer_version) < 0) {
    if (!allowFutureVersion) {
      throw new Error(
        `ARCHIVE_FUTURE_VERSION: archive requires server >= ${manifest.min_consumer_version}, have ${consumerVersion}`,
      );
    }
  }
  // M5 S3.0 — reject a newer-schema archive onto an older binary (the user must
  // upgrade the server first). `force` (allowFutureVersion) is the escape hatch.
  if (archiveSchemaTooNew(manifest.schema_version)) {
    if (!allowFutureVersion) {
      throw new Error(
        `ARCHIVE_SCHEMA_TOO_NEW: archive schema_version ${manifest.schema_version} > server ${SCHEMA_VERSION} — upgrade this server before restoring`,
      );
    }
  }
};

/** How a record body's plaintext is routed once decrypted. */
type RecordKind = 'db' | 'blob' | 'small' | 'discard';

/** In-flight state for the record currently being streamed. The body is
 *  framed `iv(12) || ciphertext || tag(16)`; we split each incoming slice
 *  across those three fixed regions (by `bodyPos`) so the iv seeds the
 *  decipher, the ciphertext streams through `update`, and the trailing 16
 *  bytes accumulate as the tag for `final`. */
interface BodyState {
  name: string;
  kind: RecordKind;
  blobHash?: string;
  /** For `kind: 'blob'` — the CAS root the prefix routes to. */
  blobNamespace?: BlobNamespace;
  bodyLen: number;
  bodyPos: number;
  ivBuf: Buffer;
  tagBuf: Buffer;
  decipher?: RecordDecipher;
  /** Streaming sink for db/blob bodies. */
  writer?: RecordWriter;
  /** Buffered plaintext for small records. */
  plainChunks?: Buffer[];
  /** Decrypted plaintext byte count for this record. */
  plainLen: number;
}

type RecordState =
  | { kind: 'name_len' }
  | { kind: 'name'; len: number }
  | { kind: 'body_len'; name: string }
  | { kind: 'body'; body: BodyState };

/** Stream an archive from disk into `consumer`, verifying it end to end:
 *  per-record AES-256-GCM tags as each body completes, then the trailing
 *  HMAC over every pre-trailer byte. Throws (without calling `consumer`'s
 *  `end` for the failing record) on a wrong key, tampering, truncation, a
 *  missing db record, or a blob-count mismatch. Memory stays flat — only a
 *  rolling 32-byte tail + the current read chunk + the consumer's own
 *  buffering are resident. */
export const streamImportArchive = async (
  opts: ImportOptions,
  consumer: ImportConsumer,
): Promise<ImportSummary> => {
  // ── Cross-phase state ────────────────────────────────────────────
  // The manifest (plaintext, at the head) must be parsed before the key
  // can be derived, so the pre-key bytes accumulate in `headBuf`; once the
  // manifest is in hand we derive keys, seed the HMAC with the head, and
  // switch to the streaming record walk.
  let keysReady = false;
  let headBuf = Buffer.alloc(0);
  let hmac: ArchiveHmac | undefined;
  let keys: ArchiveKeys | undefined;
  let manifest: ArchiveManifest | undefined;

  // Record-walk state (valid once `keysReady`).
  let rstate: RecordState = { kind: 'name_len' };
  /** Accumulator for the small fixed-width header fields (name_len / name /
   *  body_len) that may span read chunks. NEVER holds body bytes. */
  let fieldBuf = Buffer.alloc(0);

  let sawDb = false;
  let dbBytes = 0;
  let blobCount = 0;
  let sawServerVault = false;
  const smallRecordBytes: Record<string, number> = {};

  /** Pull exactly `need` bytes for a header field, draining `fieldBuf`
   *  first then `bytes[off..]`. Returns the field + the advanced chunk
   *  offset, or null when more chunks are needed (the remainder is stashed
   *  into `fieldBuf`). */
  const takeField = (
    bytes: Buffer,
    off: number,
    need: number,
  ): { field: Buffer; off: number } | null => {
    if (fieldBuf.length >= need) {
      const field = fieldBuf.subarray(0, need);
      fieldBuf = Buffer.from(fieldBuf.subarray(need));
      return { field, off };
    }
    const fromBytes = need - fieldBuf.length;
    if (bytes.length - off < fromBytes) {
      fieldBuf = Buffer.concat([fieldBuf, bytes.subarray(off)]);
      return null;
    }
    const field = Buffer.concat([fieldBuf, bytes.subarray(off, off + fromBytes)]);
    fieldBuf = Buffer.alloc(0);
    return { field, off: off + fromBytes };
  };

  const startBody = (name: string, bodyLen: number): BodyState => {
    if (bodyLen < IV_LEN + AEAD_TAG_LEN) {
      throw new Error(`ARCHIVE_INVALID: record '${name}' body too short for iv + tag`);
    }
    let kind: RecordKind;
    let blobHash: string | undefined;
    let blobNamespace: BlobNamespace | undefined;
    const blob = matchBlobRecord(name);
    if (name === FILE_NAMES.db) {
      kind = 'db';
    } else if (blob) {
      if (manifest?.includes_server_vault_bundle === true && !sawServerVault) {
        throw new Error(
          'ARCHIVE_INVALID: blob record precedes required server-vault-bundle.json',
        );
      }
      // Blob-encryption fix Phase 3 — route by posture prefix (blobs/ keyless,
      // cache-blobs/ + memory-blobs/ encrypted). Reject anything that isn't a
      // bare sha256 hex hash BEFORE the bytes reach the CAS (a `.../../x` name
      // would otherwise traverse out of the object tree).
      kind = 'blob';
      blobHash = blob.hash;
      blobNamespace = blob.namespace;
      if (!BLOB_HASH_RE.test(blobHash)) {
        throw new Error(`ARCHIVE_INVALID: blob record name '${name}' is not a content hash`);
      }
    } else if (
      name === FILE_NAMES.config ||
      name === FILE_NAMES.vault ||
      name === FILE_NAMES.serverVault ||
      name === FILE_NAMES.passport
    ) {
      kind = 'small';
    } else {
      kind = 'discard';
    }
    return { name, kind, blobHash, blobNamespace, bodyLen, bodyPos: 0, ivBuf: Buffer.alloc(0), tagBuf: Buffer.alloc(0), plainLen: 0 };
  };

  const emitPlain = async (body: BodyState, pt: Buffer): Promise<void> => {
    if (pt.length === 0) return;
    body.plainLen += pt.length;
    // Bound the one buffered-whole record class (config/vault/passport).
    if (body.kind === 'small' && body.plainLen > MAX_SMALL_RECORD_LEN) {
      throw new Error(
        `ARCHIVE_INVALID: record '${body.name}' exceeds the ${MAX_SMALL_RECORD_LEN}-byte limit for a config/vault/server-vault/passport record`,
      );
    }
    if (body.writer) await body.writer.write(pt);
    else if (body.plainChunks) body.plainChunks.push(pt);
    // discard / un-consumed small (no onSmallRecord): drop (plainLen still counts)
  };

  const finishBody = async (body: BodyState): Promise<void> => {
    let ptFinal: Buffer;
    try {
      ptFinal = body.decipher!.final(body.tagBuf);
    } catch {
      throw new Error(
        `ARCHIVE_INVALID_SIGNATURE: AEAD tag mismatch on record '${body.name}' — wrong key or tampered data`,
      );
    }
    if (ptFinal.length) await emitPlain(body, ptFinal);

    if (body.kind === 'db') {
      await body.writer!.end();
      sawDb = true;
      dbBytes = body.plainLen;
    } else if (body.kind === 'blob') {
      await body.writer!.end();
      blobCount += 1;
    } else if (body.kind === 'small') {
      // Buffered only when a consumer wants the bytes; otherwise the size
      // (plainLen) is all we kept (a summary/preview pass stays flat).
      if (body.plainChunks) {
        const bytes = Buffer.concat(body.plainChunks);
        smallRecordBytes[body.name] = bytes.length;
        await consumer.onSmallRecord!(body.name, bytes);
      } else {
        smallRecordBytes[body.name] = body.plainLen;
      }
      if (body.name === FILE_NAMES.serverVault) {
        if (sawServerVault) {
          throw new Error('ARCHIVE_INVALID: duplicate server-vault-bundle.json record');
        }
        sawServerVault = true;
      }
    }
    // discard: nothing to flush
  };

  /** Consume body bytes from `bytes[off..]`, splitting across the iv / ct /
   *  tag regions. Returns the advanced offset. */
  const consumeBody = async (bytes: Buffer, off: number, body: BodyState): Promise<number> => {
    const take = Math.min(bytes.length - off, body.bodyLen - body.bodyPos);
    const slice = bytes.subarray(off, off + take);
    let so = 0;
    const ctStart = IV_LEN;
    const tagStart = body.bodyLen - AEAD_TAG_LEN;

    // ── iv region [0, IV_LEN) ──
    if (body.bodyPos < ctStart && so < slice.length) {
      const n = Math.min(ctStart - body.bodyPos, slice.length - so);
      body.ivBuf = Buffer.concat([body.ivBuf, slice.subarray(so, so + n)]);
      so += n;
      body.bodyPos += n;
      if (body.ivBuf.length === IV_LEN) {
        body.decipher = createRecordDecipher(keys!.content, body.ivBuf);
        if (body.kind === 'db') body.writer = await consumer.onDb();
        else if (body.kind === 'blob') body.writer = await consumer.onBlob(body.blobHash!, body.blobNamespace!);
        else if (body.kind === 'small' && consumer.onSmallRecord) body.plainChunks = [];
        // discard / un-consumed small: no sink (decrypt to authenticate, drop bytes)
      }
    }
    // ── ciphertext region [IV_LEN, tagStart) ──
    if (body.bodyPos >= ctStart && body.bodyPos < tagStart && so < slice.length) {
      const n = Math.min(tagStart - body.bodyPos, slice.length - so);
      const pt = body.decipher!.update(slice.subarray(so, so + n));
      so += n;
      body.bodyPos += n;
      await emitPlain(body, pt);
    }
    // ── tag region [tagStart, bodyLen) ──
    if (body.bodyPos >= tagStart && so < slice.length) {
      const n = Math.min(body.bodyLen - body.bodyPos, slice.length - so);
      body.tagBuf = Buffer.concat([body.tagBuf, slice.subarray(so, so + n)]);
      so += n;
      body.bodyPos += n;
    }

    if (body.bodyPos === body.bodyLen) {
      await finishBody(body);
      rstate = { kind: 'name_len' };
    }
    return off + take;
  };

  /** Drive the record state machine over `bytes` (already HMAC-fed). */
  const feedRecords = async (bytes: Buffer): Promise<void> => {
    let off = 0;
    while (off < bytes.length) {
      if (rstate.kind === 'body') {
        off = await consumeBody(bytes, off, rstate.body);
        continue;
      }
      const need =
        rstate.kind === 'name_len' ? UINT32_LEN
          : rstate.kind === 'name' ? rstate.len
            : /* body_len */ UINT32_LEN;
      const got = takeField(bytes, off, need);
      if (!got) return;
      off = got.off;
      if (rstate.kind === 'name_len') {
        const len = got.field.readUInt32BE(0);
        if (len === 0 || len > MAX_RECORD_NAME_LEN) {
          throw new Error(`ARCHIVE_INVALID: record name length ${len} out of range`);
        }
        rstate = { kind: 'name', len };
      } else if (rstate.kind === 'name') {
        rstate = { kind: 'body_len', name: got.field.toString('utf8') };
      } else {
        rstate = { kind: 'body', body: startBody(rstate.name, got.field.readUInt32BE(0)) };
      }
    }
  };

  /** Feed committed (non-trailer) bytes: buffer the head until the manifest
   *  parses, then HMAC + record-walk everything thereafter. */
  const feed = async (bytes: Buffer): Promise<void> => {
    if (keysReady) {
      hmac!.update(bytes);
      await feedRecords(bytes);
      return;
    }
    headBuf = Buffer.concat([headBuf, bytes]);
    if (headBuf.length < MAGIC_LEN + UINT32_LEN) return;
    if (!headBuf.subarray(0, MAGIC_LEN).equals(MAGIC)) {
      throw new Error('ARCHIVE_INVALID: magic mismatch');
    }
    const manifestLen = headBuf.readUInt32BE(MAGIC_LEN);
    if (manifestLen > MAX_MANIFEST_LEN) {
      throw new Error(`ARCHIVE_INVALID: manifest length ${manifestLen} out of range`);
    }
    const headEnd = MAGIC_LEN + UINT32_LEN + manifestLen;
    if (headBuf.length < headEnd) return;
    const parsed = parseManifest(headBuf);
    manifest = parsed.manifest;
    checkManifestCompat(manifest, opts.consumerVersion, opts.allowFutureVersion ?? false);
    const salt = Buffer.from(manifest.encryption.salt_hex, 'hex');
    if (salt.length === 0) throw new Error('ARCHIVE_INVALID: encryption.salt_hex missing');
    keys = deriveArchiveKeys(opts.recoveryKey, salt);
    hmac = createArchiveHmac(keys.hmac);
    keysReady = true;
    // Seed the HMAC with the head (magic + len + manifest), then feed any
    // already-buffered record bytes through the streaming path.
    hmac.update(headBuf.subarray(0, headEnd));
    const rest = Buffer.from(headBuf.subarray(headEnd));
    headBuf = Buffer.alloc(0);
    if (rest.length) {
      hmac.update(rest);
      await feedRecords(rest);
    }
  };

  // ── Drive the read stream, holding back a rolling 32-byte HMAC tail ──
  let tail = Buffer.alloc(0);
  const stream = createReadStream(opts.archivePath);
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer;
      const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      if (combined.length <= HMAC_LEN) {
        tail = Buffer.from(combined);
        continue;
      }
      const commitLen = combined.length - HMAC_LEN;
      tail = Buffer.from(combined.subarray(commitLen));
      await feed(combined.subarray(0, commitLen));
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }

  // ── EOF: structural completeness FIRST, then the HMAC trailer ──
  // A cut-off file (download/copy interrupted) leaves the parser mid-record
  // OR holds back fewer than 32 trailer bytes; report that as TRUNCATED
  // rather than the scarier "invalid signature / wrong key". The HMAC
  // (which also fails on such a file) is the authority for genuine
  // tampering once the framing is whole. Per-record GCM tags were already
  // verified as each body completed during the walk.
  if (!keysReady || !manifest || !hmac) {
    throw new Error('ARCHIVE_TRUNCATED: header too short');
  }
  if (tail.length < HMAC_LEN) {
    throw new Error('ARCHIVE_TRUNCATED: HMAC trailer missing');
  }
  if (rstate.kind !== 'name_len' || fieldBuf.length !== 0) {
    throw new Error('ARCHIVE_TRUNCATED: incomplete final record');
  }
  const expectedSig = hmac.finalize();
  if (!expectedSig.equals(tail)) {
    throw new Error('ARCHIVE_INVALID_SIGNATURE: HMAC trailer mismatch — archive tampered or wrong recovery key');
  }
  if (!sawDb) {
    throw new Error('ARCHIVE_INVALID: missing db.sqlite record');
  }
  if (blobCount !== manifest.blob_count) {
    throw new Error(
      `ARCHIVE_INVALID: manifest says ${manifest.blob_count} blobs, found ${blobCount}`,
    );
  }
  if ((manifest.includes_server_vault_bundle === true) !== sawServerVault) {
    throw new Error(
      `ARCHIVE_INVALID: manifest includes_server_vault_bundle=${String(manifest.includes_server_vault_bundle === true)} `
        + `but record present=${String(sawServerVault)}`,
    );
  }

  return { manifest, dbBytes, blobCount, smallRecordBytes };
};

/** Verify an archive end to end WITHOUT retaining any completed record —
 *  decrypts the db + blobs only to authenticate their tags + the HMAC,
 *  validates the D-212 server bundle while it is transiently buffered, and
 *  returns the manifest + decrypted sizes. Memory-flat for bulk records,
 *  for previews (e.g. the CLI `--dry-run`). */
export const summarizeArchive = async (opts: ImportOptions): Promise<ImportSummary> =>
  streamImportArchive(opts, {
    onDb: () => DISCARD_RECORD_WRITER,
    onBlob: () => DISCARD_RECORD_WRITER,
    onSmallRecord(name, bytes) {
      if (name === FILE_NAMES.serverVault) {
        serverBundleFromJSON(bytes.toString('utf8'));
      }
    },
  });

/** Buffered convenience adapter over `streamImportArchive`: collect every
 *  record into memory and return the legacy `ImportedRecords` shape. This
 *  reintroduces the whole-archive-in-RAM peak, so it is for TESTS +
 *  small-archive callers only — restore + preview go through the streaming
 *  consumer / `summarizeArchive` directly. */
export const importArchive = async (opts: ImportOptions): Promise<ImportedRecords> => {
  let db: Buffer | undefined;
  const small: Partial<Record<string, Buffer>> = {};
  const blobs: ImportedRecords['blobs'] = [];

  const summary = await streamImportArchive(opts, {
    onDb() {
      const chunks: Buffer[] = [];
      return { write: (c) => { chunks.push(c); }, end: () => { db = Buffer.concat(chunks); } };
    },
    onBlob(hash, namespace) {
      const chunks: Buffer[] = [];
      return {
        write: (c) => { chunks.push(c); },
        end: () => { blobs.push({ hash, bytes: Buffer.concat(chunks), namespace }); },
      };
    },
    onSmallRecord(name, bytes) { small[name] = bytes; },
  });

  // `streamImportArchive` already throws on a missing db; this narrows the type.
  if (!db) throw new Error('ARCHIVE_INVALID: missing db.sqlite record');

  return {
    manifest: summary.manifest,
    db,
    config: small[FILE_NAMES.config],
    vault: small[FILE_NAMES.vault],
    serverVault: small[FILE_NAMES.serverVault],
    passport: small[FILE_NAMES.passport],
    blobs,
  };
};
