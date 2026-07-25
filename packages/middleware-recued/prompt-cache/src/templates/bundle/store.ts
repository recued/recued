/** D-164 P4g-3 — bundle manifest on-disk store.
 *
 *  `createFileBundleStore({path})` returns a `BundleStore` whose
 *  state is the latest `BundleManifest` written to disk, with an
 *  in-memory cache layered on top so callers don't pay an I/O round
 *  trip per `current()` call. The store is a pure persistence +
 *  caching primitive; the poller (`./poller.ts`) drives writes from
 *  upstream fetches, and the `createStoreBackedFetcher` adapter
 *  (`./index.ts`) exposes the store as a `BundleFetcher` so
 *  `loadBundlePool` can build the pool from disk without re-fetching.
 *
 *  Atomic writes. `put` serialises the manifest to JSON, writes to
 *  `<path>.tmp.<random>` (collision-resistant suffix so two
 *  concurrent puts don't trample each other), then renames to the
 *  final path. The rename step is atomic on every Unix filesystem
 *  the server runs on, so a crash mid-write leaves the previous
 *  manifest intact rather than a half-written corrupted file.
 *
 *  Load semantics. On construction `loadFromDisk` reads the file;
 *  missing file returns `null` (`current()` then returns `null`
 *  too, signalling "no cache yet"). Read errors (permission denied,
 *  corrupt JSON, schema mismatch) throw `BundleFetchError` with the
 *  same `reason` taxonomy used by the HTTP fetcher
 *  (`parse_error` / `schema_invalid` / `network_error`) so callers
 *  can handle disk + network failures uniformly.
 *
 *  **Server-only.** Uses `node:fs/promises` + `node:path` + `node:crypto`
 *  for atomic-rename + temp-name generation. The prompt-cache package
 *  is server-side per design (D-148 P12 — "no client-side execution").
 *
 *  Out of scope for P4g-3 (deferred):
 *    - Per-template content-addressed cache (one file per template_hash).
 *      The current store persists the whole manifest as one file. Splitting
 *      by hash makes sense if the manifest grows large enough that
 *      partial updates become attractive; not P4g-3's problem.
 *    - File locking. Concurrent boots writing the same store path are not
 *      defended against; the rename's last-writer-wins semantics keep one
 *      manifest valid but the order is unpredictable. Production has one
 *      writer per host (the poller), so this is acceptable.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates/bundle (store + poller layout) / § 3 the deterministic
 *  gate. */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  BundleFetchError,
  parseBundleManifest,
  type BundleManifest,
} from './fetch.js';

/** Pure persistence primitive. Exposes the current cached manifest +
 *  a `put` to replace it. Implementations stay tiny — the manifest's
 *  validation lives in `parseBundleManifest` / the bundle pool, not
 *  here. */
export interface BundleStore {
  /** The latest manifest stored, or `null` when nothing's cached
   *  (initial empty state). Synchronous — the in-memory cache makes
   *  this safe to call per `match()` iteration without I/O. */
  current(): BundleManifest | null;
  /** Replace the cached manifest and persist atomically to disk.
   *  Returns once the rename completes. Throws on filesystem errors;
   *  the in-memory cache only updates after the write succeeds, so a
   *  failed `put` leaves `current()` unchanged. */
  put(manifest: BundleManifest): Promise<void>;
}

export interface CreateFileBundleStoreOptions {
  /** Absolute filesystem path the manifest is persisted under.
   *  The parent directory is `mkdir`'d on construction (recursive)
   *  so callers don't need to pre-create it. */
  readonly path: string;
}

/** Generate a collision-resistant temp suffix so two concurrent
 *  `put`s on the same path don't trample each other's temp files.
 *  Hex-encoded so the suffix is filesystem-safe everywhere. */
const tempSuffix = (): string => randomBytes(8).toString('hex');

/** Read + parse the manifest from disk. Returns `null` when the file
 *  is missing (the "no cache yet" signal); throws `BundleFetchError`
 *  for any other failure mode. Disk errors get `disk_error`; JSON
 *  parse failures get `parse_error`; schema failures get
 *  `schema_invalid` (re-raised from `parseBundleManifest`). */
const loadFromDisk = async (path: string): Promise<BundleManifest | null> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BundleFetchError({
      reason: 'disk_error',
      detail: `read ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new BundleFetchError({
      reason: 'parse_error',
      detail: `cache file ${JSON.stringify(path)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return parseBundleManifest(json);
};

/** Persist a manifest atomically: write to a temp path, then rename.
 *  The temp lives in the same directory as the final path so the
 *  rename never crosses a filesystem boundary (EXDEV is impossible
 *  by construction). On any failure the temp file is best-effort
 *  unlinked so half-written cruft doesn't accumulate; the rename
 *  never runs and the previous final file (if any) survives.
 *
 *  No fsync — the store caches an idempotently-refetchable upstream
 *  artifact; a crash mid-write loses at most one update + a stale
 *  temp file, both recoverable by the next poller tick. */
const persistAtomically = async (
  path: string,
  manifest: BundleManifest,
): Promise<void> => {
  const tempPath = `${path}.tmp.${tempSuffix()}`;
  const payload = JSON.stringify(manifest);
  try {
    await writeFile(tempPath, payload, { encoding: 'utf8' });
  } catch (err) {
    // Even a failed write can leave a partial temp file on some
    // filesystems (e.g., out-of-space after the inode was created);
    // unlink it so we don't accumulate stale temps across retries.
    await unlink(tempPath).catch(() => undefined);
    throw new BundleFetchError({
      reason: 'disk_error',
      detail: `write ${JSON.stringify(tempPath)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  try {
    await rename(tempPath, path);
  } catch (err) {
    // Best-effort cleanup; ignore unlink failures because the temp
    // file may already be gone (e.g., rename succeeded but threw on
    // a follow-up FS sync).
    await unlink(tempPath).catch(() => undefined);
    throw new BundleFetchError({
      reason: 'disk_error',
      detail: `rename ${JSON.stringify(tempPath)} → ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};

/** Build the FS-backed store. Reads the parent directory's existence
 *  via `mkdir(recursive)`, then loads any existing manifest into the
 *  in-memory cache. Subsequent `put` writes are atomic + update the
 *  cache on success. */
export const createFileBundleStore = async (
  options: CreateFileBundleStoreOptions,
): Promise<BundleStore> => {
  const { path } = options;
  await mkdir(dirname(path), { recursive: true });
  let cached: BundleManifest | null = await loadFromDisk(path);
  return {
    current(): BundleManifest | null {
      return cached;
    },
    async put(manifest: BundleManifest): Promise<void> {
      await persistAtomically(path, manifest);
      cached = manifest;
    },
  };
};
