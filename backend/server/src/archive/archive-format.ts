/** Phase F (D-108) — portable archive format.
 *
 *  Wire layout (Commit 1):
 *    [ 4 bytes  "RECA"                     magic                     ]
 *    [ 4 bytes  uint32 BE  manifest length                           ]
 *    [ N bytes  manifest JSON (plaintext, UTF-8)                     ]
 *    repeating records until HMAC:
 *      [ 4 bytes  uint32 BE  name length                             ]
 *      [ M bytes  utf-8 name                                         ]
 *      [ 4 bytes  uint32 BE  body length (post-encryption)           ]
 *      [ B bytes  encrypted body = iv(12) || ct(N+tag(16))           ]
 *    [ 32 bytes  HMAC-SHA-256 over every prior byte                  ]
 *
 *  Keeping the manifest plaintext lets consumers run version
 *  compatibility checks BEFORE decrypting any record (D-108 #3).
 *  Per-file AEAD means streaming verify/decrypt without buffering
 *  the whole archive, which keeps memory flat on GB-sized exports.
 *
 *  The HMAC covers both plaintext + ciphertext bytes, preventing
 *  selective-file substitution (e.g. swapping a blob record for
 *  a stale one). Keyed separately from the content key via HKDF
 *  domain separation (`recued-archive-v1-hmac`).
 */

export const MAGIC = Buffer.from('RECA', 'utf8');
export const MAGIC_LEN = 4;
export const UINT32_LEN = 4;
export const HMAC_LEN = 32;
export const IV_LEN = 12;
export const AEAD_TAG_LEN = 16;

/** Current archive format version. Bump on breaking layout changes.
 *  v2 (blob-encryption fix Phase 2): blob records are split by encryption
 *  posture across `blobs/` (keyless), `cache-blobs/` (cache + collections), and
 *  `memory-blobs/` (memory), all carrying PLAINTEXT. A pre-v2 consumer refuses a
 *  v2 archive at the `archive_format_version > ARCHIVE_FORMAT_VERSION` gate
 *  (`archive-import.ts`) rather than silently discarding the new record kinds. */
export const ARCHIVE_FORMAT_VERSION = 2;

/** Current schema version for SQLite tables. Bump when warehouse /
 *  server_state / vault table schemas change shape in a way that
 *  requires migration. Phase F starts at 1; Phase G (D-109) bumps
 *  to 2 when the `event_triggers` table lands (archive format
 *  version stays 1 — triggers ride as another table inside the same
 *  envelope). */
export const SCHEMA_VERSION = 2;

/** Minimum consumer version that understands this archive. Bumped
 *  alongside breaking format changes. Producers always write their
 *  own version; the consumer rejects if current < min_consumer.
 *  Bumped to 0.2.0 for the blob-encryption fix (posture-split, plaintext-
 *  carrying blob records that only a Phase-3+ restore can route). */
export const MIN_CONSUMER_VERSION = '0.2.0';

export interface ArchiveManifest {
  producer_version: string;
  min_consumer_version: string;
  archive_format_version: number;
  schema_version: number;
  created_at: number;
  source_host?: string;
  db_size_bytes: number;
  blob_count: number;
  blob_bytes: number;
  encryption: {
    algorithm: 'aes-256-gcm';
    key_derivation: 'hkdf-sha-256';
    /** HKDF salt; hex-encoded. */
    salt_hex: string;
    info: 'recued-archive-v1';
  };
}

/** Standard file names inside an archive. Using fixed names keeps
 *  the format simple — no file-tree encoding, just a flat key→bytes
 *  map plus special handling for the blob subtree. */
export const FILE_NAMES = {
  db: 'db.sqlite',
  config: 'config.toml',
  vault: 'vault-bundle.json',
  /** A signed `migration_full` server passport (D-148 § A.9) attesting the
   *  identity that produced THIS snapshot. Optional (the export-time
   *  "include identity passport" toggle). On import it is the provenance
   *  receipt M5's cross-machine migration commits old→new lineage from. */
  passport: 'passport.json',
} as const;

/** Blob records are named `<prefix><hash>`, split by the source store's
 *  encryption posture (blob-encryption fix Phase 2) so the importer can route
 *  each to the right restore store + re-encrypt under the restoring server's
 *  key. `hash` is always the CAS hash of the PLAINTEXT (what the archive
 *  carries), matching `<table>.blob_hash`. The bare `blobs/` prefix stays the
 *  KEYLESS root (shared + annotation) for backward compatibility. The three
 *  prefixes are mutually non-overlapping (distinct leading text), so the
 *  importer's `startsWith` routing is order-independent. */
export const BLOB_NAME_PREFIX = 'blobs/';
/** Cache + collection bodies (the encrypted `cache_blobs` root). */
export const CACHE_BLOB_NAME_PREFIX = 'cache-blobs/';
/** Memory bodies (the encrypted `memory_blobs` root). Populated in Phase 4. */
export const MEMORY_BLOB_NAME_PREFIX = 'memory-blobs/';

/** HKDF `info` strings for content + HMAC subkey derivation. */
export const CONTENT_INFO = Buffer.from('recued-archive-v1', 'utf8');
export const HMAC_INFO = Buffer.from('recued-archive-v1-hmac', 'utf8');
