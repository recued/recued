/** D-192 — the file SOURCE family canonical projection.
 *
 *  The `file_meta_ref` posture (SourceRegistration.sync_posture) mirrors a
 *  remote vendor file's metadata without fetching its body. A compiled
 *  per-vendor Source leaf lists the owner's Dropbox/Drive/Box/OneDrive/
 *  SharePoint/S3/Notion tree and projects each
 *  object into THIS one canonical shape; the `file_meta_ref` meta-store
 *  stores it. The projection generalizes across document products AND
 *  object stores (S3: `key -> path`, `LastModified -> mtime`,
 *  `ContentType -> mime_type`, `ETag -> revision`, `bucket/key -> remote_id`).
 *
 *  Vocabulary is aligned with the CAS `DataFileHotFields` /
 *  `FileStorageRef` remote variant where the two postures overlap
 *  (`filename` / `mime_type` / `size` / `provider` / `remote_id`) so the
 *  unified `data.file.*` read surface (Fork B — one file entity kind, two
 *  storage postures) projects both consistently. The remote-only extras
 *  (`path` / `mtime` / `owner` / `revision`) have no CAS analogue.
 *
 *  `(provider, remote_id)` is the pointer; an explicit read may resolve bytes
 *  lazily through that provider without adding them to the sync mirror. Design:
 *  D-192; taxonomy §3b. */

/** Cap on `filename` — code units, aligned with the D-172
 *  `FILENAME_MAX_BYTES` convention (same 255 bound). */
export const FILE_META_FILENAME_MAX = 255;
/** Cap on `path` — a full vendor-tree path can be deep. */
export const FILE_META_PATH_MAX = 1024;
/** Cap on the remaining scalar string fields (mime_type / owner / revision
 *  / provider / remote_id). */
export const FILE_META_STRING_MAX = 255;

export interface FileMetaProjection {
  /** The file's display name (the vendor's leaf name). Aligns with
   *  `DataFileHotFields.filename`. Required. */
  filename: string;
  /** Full path within the vendor tree (remote-only; no CAS analogue). */
  path?: string;
  /** MIME type. Aligns with `DataFileHotFields.mime_type`. */
  mime_type?: string;
  /** Size in bytes. Aligns with `DataFileHotFields.size`. */
  size?: number;
  /** Vendor last-modified time (epoch ms). Remote-only. */
  mtime?: number;
  /** Vendor-reported owner (id / email). Remote-only. */
  owner?: string;
  /** Vendor revision / etag / versionId — the change token. Remote-only. */
  revision?: string;
  /** The remote provider slug (dropbox | gdrive | box | onedrive |
   *  sharepoint | s3 | notion | …). Aligns with `FileStorageRef` remote
   *  `provider`. Required — half the pointer. */
  provider: string;
  /** The vendor's opaque file id. Aligns with `FileStorageRef` remote
   *  `remote_id`. Required — half the pointer. */
  remote_id: string;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isNonEmptyStringWithin = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const isOptionalStringWithin = (v: unknown, max: number): boolean =>
  v === undefined || (typeof v === 'string' && v.length > 0 && v.length <= max);

/** Fail-closed shape validation — returns a list of error strings (empty =
 *  valid), the `assert*Shape` idiom used across the vendor declarations.
 *  Required: `filename`, `provider`, `remote_id` (all non-empty, capped).
 *  Optional fields, when present, must be non-empty strings within cap /
 *  finite non-negative numbers. */
export const validateFileMetaProjection = (v: unknown): string[] => {
  const errs: string[] = [];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return ['file meta must be an object'];
  }
  const p = v as Record<string, unknown>;
  if (!isNonEmptyStringWithin(p.filename, FILE_META_FILENAME_MAX)) {
    errs.push(`filename is required (non-empty, <= ${FILE_META_FILENAME_MAX} chars)`);
  }
  if (!isNonEmptyStringWithin(p.provider, FILE_META_STRING_MAX)) {
    errs.push(`provider is required (non-empty, <= ${FILE_META_STRING_MAX} chars)`);
  }
  if (!isNonEmptyStringWithin(p.remote_id, FILE_META_STRING_MAX)) {
    errs.push(`remote_id is required (non-empty, <= ${FILE_META_STRING_MAX} chars)`);
  }
  if (!isOptionalStringWithin(p.path, FILE_META_PATH_MAX)) {
    errs.push(`path must be a non-empty string <= ${FILE_META_PATH_MAX} chars when present`);
  }
  if (!isOptionalStringWithin(p.mime_type, FILE_META_STRING_MAX)) {
    errs.push('mime_type must be a non-empty string within cap when present');
  }
  if (!isOptionalStringWithin(p.owner, FILE_META_STRING_MAX)) {
    errs.push('owner must be a non-empty string within cap when present');
  }
  if (!isOptionalStringWithin(p.revision, FILE_META_STRING_MAX)) {
    errs.push('revision must be a non-empty string within cap when present');
  }
  if (p.size !== undefined && (!isFiniteNumber(p.size) || p.size < 0)) {
    errs.push('size must be a finite, non-negative number when present');
  }
  if (p.mtime !== undefined && !isFiniteNumber(p.mtime)) {
    errs.push('mtime must be a finite number (epoch ms) when present');
  }
  return errs;
};

/** Boolean guard over {@link validateFileMetaProjection}. */
export const isFileMetaProjection = (v: unknown): v is FileMetaProjection =>
  validateFileMetaProjection(v).length === 0;
