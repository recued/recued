/** M1 — export-archive on-disk lifecycle (the `<data_path>/exports/` slot).
 *
 *  Phase F/G wrote `recued-<datetime>-<rand>.recued.archive` files into
 *  `exports/` and NEVER deleted them: `archive-handler`'s `pruneExpired`
 *  only dropped the in-memory job record, so every export leaked its
 *  (potentially multi-GB) file forever. This module is the hygiene layer:
 *
 *    - `newExportPath`     — the unique, datetime-stamped target path.
 *    - `evictOtherExports` — single-latest slot: a fresh export deletes the
 *                            prior one (the common-case cleanup).
 *    - `pruneExpiredExports` — TTL backstop: deletes export files past the
 *                            7-day window (catches a last export never
 *                            replaced + orphans from a prior process
 *                            lifetime, since the in-memory job map is gone
 *                            after a restart but the file persists).
 *    - `pruneInterruptedExportPartials` — removes authenticated-ciphertext
 *                            assembly files a hard exit stranded mid-export.
 *    - `estimateExportBytes` — conservative peak-disk estimate for the
 *                            statfs pre-flight (refuse before ENOSPC).
 *
 *  Pure filesystem helpers over a `data_path` — no db, no crypto — so the
 *  whole slot is unit-testable against a tmpdir.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** Lifetime of an export archive on disk AND of its queryable in-memory
 *  job record — single-sourced here so the two never diverge (the handover
 *  "extend the job-record lifetime to the file TTL"). 7 days. */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Fixed headroom added to the export-size estimate so the pre-flight
 *  leaves slack for AEAD per-record overhead, the manifest, WAL churn on
 *  the live db during its consistent snapshot, and general filesystem slop. 64 MB. */
export const EXPORT_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Suffix every export archive carries. */
export const EXPORT_SUFFIX = '.recued.archive';

/** Exact shape of an RPC-generated export slot name:
 *  `recued-<ISO-with-:.→->-Z>-<8 hex>.recued.archive`. Cleanup (eviction +
 *  TTL sweep) is restricted to THIS pattern — `exports/` is also the
 *  relative import base (`resolveImportPath`), so a user / the CLI may stage
 *  an arbitrarily-named `*.recued.archive` there to restore from. Matching
 *  only our own generated names means the GC never deletes a hand-placed
 *  restore source. */
const GENERATED_EXPORT_RE =
  /^recued-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.recued\.archive$/;

/** True iff `name` is an RPC-generated export slot file (see the regex). */
export const isGeneratedExportName = (name: string): boolean =>
  GENERATED_EXPORT_RE.test(name);

/** Exact hard-exit residue of an RPC-generated export. The suffix is appended
 *  to a name we already own; hand-placed archives and arbitrary `.partial`
 *  files never match. */
export const isGeneratedExportPartialName = (name: string): boolean =>
  name.endsWith('.partial')
  && isGeneratedExportName(name.slice(0, -'.partial'.length));

/** Prefix for an M4b.1 archive-upload STAGING file. Deliberately NOT the
 *  `recued-` export prefix, so `isGeneratedExportName` is false for it: the
 *  export GC (eviction + TTL sweep) and the `/ws/download` socket both restrict
 *  themselves to generated names and therefore leave a staged upload untouched.
 *  It still lives in `exports/` so `resolveImportPath` resolves the relative
 *  basename for `server.archive.import`. */
const ARCHIVE_STAGING_PREFIX = 'recued-upload-';

/** Lifetime of a staged upload on disk. A staged archive is meant to be imported
 *  promptly (the migrate flow stages then imports); one left past this window is
 *  abandoned (uploaded but never imported, or already imported) and reclaimed by
 *  the `archive-upload-sweep` housekeeping task. Aligned with the upload session
 *  resume window so a pause-then-resume migrate is never swept mid-flight. 6h. */
export const ARCHIVE_STAGING_TTL_MS = 6 * 60 * 60 * 1000;

/** Exact shape of a minted archive-upload staging file:
 *  `recued-upload-<32 hex>.recued.archive`. Like `GENERATED_EXPORT_RE`, the
 *  cleanup sweep is restricted to THIS exact pattern so a user-/CLI-staged
 *  restore archive that merely shares the prefix is never swept. The 32 hex are
 *  the first half of `sha256(upload_id)` (see `archiveStagingName`). */
const ARCHIVE_STAGING_RE = /^recued-upload-[0-9a-f]{32}\.recued\.archive$/;

/** Deterministic basename for the staged archive of an upload session:
 *  `recued-upload-<32 hex of sha256(upload_id)>.recued.archive`. Derived from
 *  `upload_id` (NOT carrying the raw session capability in the filename) so the
 *  finalize materialize step is idempotent — a retry re-links to the SAME path.
 *  Each upload gets its OWN staging path (no single-slot eviction), so concurrent
 *  finalizes never race or strand a finalized upload's still-valid staged file. */
export const archiveStagingName = (uploadId: string): string => {
  const digest = createHash('sha256').update(uploadId).digest('hex').slice(0, 32);
  return `${ARCHIVE_STAGING_PREFIX}${digest}${EXPORT_SUFFIX}`;
};

/** True iff `name` is a minted archive-upload staging file (exact match — see
 *  `ARCHIVE_STAGING_RE`). Restricting cleanup to the exact shape means a
 *  prefix-sharing user file is never swept (mirrors `isGeneratedExportName`). */
export const isArchiveStagingName = (name: string): boolean =>
  ARCHIVE_STAGING_RE.test(name);

/** TTL sweep — delete archive-upload staging files whose mtime is older than
 *  `ttlMs`. The backstop that reclaims a staged archive once it's been imported
 *  (or abandoned) — the export GC ignores staging names by design, so without
 *  this a finalized-but-unimported archive would persist forever. Restricted to
 *  the exact `ARCHIVE_STAGING_RE` shape (never a hand-placed restore source).
 *  Best-effort per file (a vanished / open-on-Windows file is skipped). Returns
 *  the paths removed. */
export const pruneStagedArchives = (
  dataPath: string,
  ttlMs: number,
  nowMs: number,
): string[] => {
  const dir = exportsDir(dataPath);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = nowMs - ttlMs;
  const deleted: string[] = [];
  for (const name of names) {
    if (!isArchiveStagingName(name)) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) {
      try {
        unlinkSync(path);
        deleted.push(path);
      } catch {
        /* best effort */
      }
    }
  }
  return deleted;
};

/** `<data_path>/exports/` — where exports land. */
export const exportsDir = (dataPath: string): string => join(dataPath, 'exports');

/** Reclaim incomplete RPC export assembly after a process death. No age gate:
 *  this runs while composing a fresh archive runtime, before an export can be
 *  active in this process. The bytes are encrypted, but a multi-GB partial that
 *  no GC recognizes is still a launch-threatening disk leak. */
export const pruneInterruptedExportPartials = (dataPath: string): string[] => {
  const dir = exportsDir(dataPath);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const deleted: string[] = [];
  for (const name of names) {
    if (!isGeneratedExportPartialName(name)) continue;
    const path = join(dir, name);
    try {
      unlinkSync(path);
      deleted.push(path);
    } catch { /* best effort */ }
  }
  return deleted;
};

/** A fresh, unique export path: `recued-<iso-datetime>-<rand>.recued.archive`.
 *  The datetime IS the snapshot cutoff; the random suffix guarantees two
 *  exports in the same millisecond never collide. The name
 *  always satisfies `GENERATED_EXPORT_RE` so the GC recognizes it as its own. */
export const newExportPath = (dataPath: string, nowMs: number): string => {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  return join(exportsDir(dataPath), `recued-${stamp}-${rand}${EXPORT_SUFFIX}`);
};

/** Absolute paths of every RPC-GENERATED export archive on disk. Restricted
 *  to `GENERATED_EXPORT_RE` so an in-flight `.partial` assembly (wrong suffix)
 *  AND any user-/CLI-staged restore archive (wrong name shape) are
 *  both left untouched by the cleanup paths that consume this list. */
const listExports = (dataPath: string): string[] => {
  const dir = exportsDir(dataPath);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => isGeneratedExportName(n))
    .map((n) => join(dir, n));
};

/** Single-latest slot — delete every export archive that is not strictly
 *  NEWER than the one we just wrote (`keepPath`). The caller serializes
 *  exports (the handler's `exportInFlight` latch; the CLI is one-shot), so
 *  the just-written file is always the freshest and the only files this
 *  finds are genuinely prior snapshots — deleted, `keepPath` excluded by
 *  identity. The `mtime <= keepMtime` test (not a blunt delete-everything-
 *  but-keep) is belt-and-suspenders for a non-serialized direct caller: it
 *  never removes a file with a strictly-greater mtime, so a concurrent
 *  later export's output can't be nuked. Equal mtimes (two writes in one
 *  filesystem tick) ARE evicted so the slot never strands a same-tick
 *  duplicate. Best-effort unlink (a vanished / locked file is skipped).
 *  Returns the paths removed. */
export const evictOtherExports = (
  dataPath: string,
  keepPath: string,
): string[] => {
  let keepMtime: number;
  try {
    keepMtime = statSync(keepPath).mtimeMs;
  } catch {
    // The kept file isn't there (write failed / already gone) — nothing to
    // anchor an age comparison against, so evict nothing.
    return [];
  }
  const deleted: string[] = [];
  for (const path of listExports(dataPath)) {
    if (path === keepPath) continue;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime <= keepMtime) {
      try {
        unlinkSync(path);
        deleted.push(path);
      } catch {
        /* best effort */
      }
    }
  }
  return deleted;
};

/** TTL sweep — delete export archives whose mtime is older than `ttlMs`.
 *  Backstops `evictOtherExports` for a last export never replaced and for
 *  orphans left by a prior process lifetime. Best-effort per file. Returns
 *  the paths removed. */
export const pruneExpiredExports = (
  dataPath: string,
  ttlMs: number,
  nowMs: number,
): string[] => {
  const cutoff = nowMs - ttlMs;
  const deleted: string[] = [];
  for (const path of listExports(dataPath)) {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) {
      try {
        unlinkSync(path);
        deleted.push(path);
      } catch {
        /* best effort */
      }
    }
  }
  return deleted;
};

/** Conservative peak-disk estimate for an export. Peak footprint is the
 *  temp consistent db copy (~one db) PLUS the assembled archive (~one db +
 *  the bundled blobs + per-record AEAD overhead), so we budget
 *  `2 × dbBytes + blobBytes + headroom`. `blobBytes` is the PLAINTEXT size of
 *  the REFERENCED blobs the export actually bundles (the caller sums
 *  `BlobStore.plaintextSizeOf` across the root-split sources) — NOT the
 *  whole CAS tree, so orphaned/stale objects (already counted against free
 *  space) don't inflate the estimate into a false `insufficient_storage`. The
 *  caller adds the transient decrypt-scratch peak separately (see
 *  `preflightExport`). */
export const estimateExportBytes = (
  dbBytes: number,
  blobBytes: number,
): number => dbBytes * 2 + blobBytes + EXPORT_HEADROOM_BYTES;

/** Human-readable byte size for the pre-flight refusal message
 *  ("need ~X, Y free"). Binary units, one decimal above MB. */
export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit >= 2 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded} ${units[unit]}`;
};
