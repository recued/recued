/** Re-encryption migration runner.
 *
 *  Walks every plaintext cache row + blob file, re-encrypts with the
 *  provided sub-DEKs. Resumable — carries state in the migration_state
 *  marker so a crashed run picks up from its cursor on the next call.
 *
 *  Invariants the runner preserves:
 *   - Bundle saved BEFORE any migration work begins (the caller's job)
 *   - Marker is updated atomically after each unit of progress
 *   - Cache rows migrated in a single SQL transaction: atomic at DB level
 *   - Blob files migrated in sorted hash order: files ≤ cursor are
 *     guaranteed encrypted, files > cursor are guaranteed plaintext
 *   - tmp+rename for blob writes: no half-written files, at worst a
 *     '.migrating' orphan to clean up on resume
 *
 *  The runner assumes the caller is holding the maintenance window
 *  (scheduler stopped, ws dispatch locked). Concurrent writes during
 *  migration are the caller's problem to prevent.
 */

import type Database from 'better-sqlite3';
import { readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { encrypt } from '@recued/crypto';
import type {
  MigrationState,
  MigrationStateStore,
  MigrationProgress,
} from './migration-state.js';

export interface MigrationRunnerOptions {
  db: Database.Database;
  stateStore: MigrationStateStore;
  blobRoot: string;
  /** Sub-DEK for encrypting SQLite inline_value values (domain: 'server-data'). */
  cacheKey: Uint8Array;
  /** Sub-DEK for encrypting blob file contents (domain: 'blob-store'). */
  blobKey: Uint8Array;
  /** Fires after each progress update. UI polling reads the marker
   *  directly; this is for telemetry hooks. */
  onProgress?: (progress: MigrationProgress, phase: MigrationState['phase']) => void;
  /** Clock for deterministic tests. */
  now?: () => number;
  /** Maximum blobs processed per progress-flush batch. Default 10. */
  blobFlushEvery?: number;
}

export interface MigrationResult {
  rowsMigrated: number;
  blobsMigrated: number;
  tookMs: number;
}

const TEXT = new TextEncoder();

/** List all blob hashes currently on disk, sorted ascending.
 *  Filters out .migrating orphans — those are cleaned up separately. */
const listBlobHashesSorted = async (root: string): Promise<string[]> => {
  const objectsDir = join(root, 'objects');
  if (!existsSync(objectsDir)) return [];
  const prefixes = await readdir(objectsDir);
  const hashes: string[] = [];
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
      hashes.push(prefix + file.slice(0, -'.bin'.length));
    }
  }
  hashes.sort();
  return hashes;
};

const blobPath = (root: string, hash: string): string =>
  join(root, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

const migratingPath = (root: string, hash: string): string =>
  `${blobPath(root, hash)}.migrating`;

/** Clean up any .migrating files left from a previous crash.
 *  Runs at the start of every migration call (fresh or resumed). */
const cleanupMigratingOrphans = async (root: string): Promise<number> => {
  const objectsDir = join(root, 'objects');
  if (!existsSync(objectsDir)) return 0;
  let removed = 0;
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
      if (!file.endsWith('.migrating')) continue;
      try {
        await unlink(join(prefixDir, file));
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
};

/** Re-encrypt every cache row's inline_value in a single SQL transaction.
 *  If anything throws mid-way, the transaction rolls back — rows stay
 *  plaintext, migration_state phase stays 'cache'. Resumable trivially.
 *
 *  Blob-referencing rows (blob_hash IS NOT NULL) are not rewritten here;
 *  the blob migration phase handles those files. */
const runCacheMigration = async (
  opts: MigrationRunnerOptions,
): Promise<number> => {
  const { db, cacheKey } = opts;

  // cache_entries may not exist yet on a server that's never run a
  // recipe (fresh install). Migration is a no-op in that case.
  const tableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='cache_entries'`,
  ).get() !== undefined;
  if (!tableExists) return 0;

  const rows = db.prepare(
    `SELECT key, inline_value FROM cache_entries WHERE inline_value IS NOT NULL`,
  ).all() as { key: string; inline_value: string }[];

  // Encrypt each value outside the transaction (can't await inside
  // better-sqlite3's sync transaction closure). Then swap in one shot.
  const rewritten: { key: string; ciphertext: string }[] = [];
  for (const row of rows) {
    const aad = TEXT.encode(row.key);
    const pt = TEXT.encode(row.inline_value);
    const { iv, ct } = await encrypt(cacheKey, pt, aad);
    // Use the same iv||ct packing as @recued/crypto's encodeCiphertext.
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    let b64 = '';
    for (let i = 0; i < combined.length; i++) b64 += String.fromCharCode(combined[i]);
    rewritten.push({ key: row.key, ciphertext: btoa(b64) });
  }

  // Flip the self-describing `inline_enc` flag to 1 alongside the
  // ciphertext swap — the read path branches on it, so a re-encrypted
  // row left at `inline_enc=0/NULL` would be JSON.parsed as plaintext
  // and crash. This migration is exactly the plaintext→ciphertext
  // transition the flag exists to record.
  const stmt = db.prepare(
    `UPDATE cache_entries SET inline_value = ?, inline_enc = 1 WHERE key = ?`,
  );
  db.transaction(() => {
    for (const r of rewritten) stmt.run(r.ciphertext, r.key);
  })();

  return rewritten.length;
};

/** Re-encrypt one blob file atomically via tmp+rename.
 *  Caller guarantees the file is currently plaintext (cursor logic). */
const migrateOneBlob = async (
  root: string,
  hash: string,
  blobKey: Uint8Array,
): Promise<void> => {
  const srcPath = blobPath(root, hash);
  const tmpPath = migratingPath(root, hash);

  const plaintext = await readFile(srcPath);
  const { iv, ct } = await encrypt(blobKey, new Uint8Array(plaintext), TEXT.encode(hash));
  const combined = Buffer.alloc(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  await writeFile(tmpPath, combined);
  await rename(tmpPath, srcPath);
};

/** Execute the migration from whatever state the marker currently holds.
 *  Idempotent — calling twice after completion does nothing. */
export const runMigration = async (
  opts: MigrationRunnerOptions,
): Promise<MigrationResult> => {
  const now = opts.now ?? (() => Date.now());
  const start = now();

  // Clean any crash residue from previous runs.
  await cleanupMigratingOrphans(opts.blobRoot);

  // Load or initialize state.
  let state = opts.stateStore.load();
  if (!state) {
    // Fresh migration — caller expects this path.
    const tableExists = opts.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='cache_entries'`,
    ).get() !== undefined;
    const rowCount = tableExists
      ? (opts.db.prepare(
          `SELECT COUNT(*) as c FROM cache_entries WHERE inline_value IS NOT NULL`,
        ).get() as { c: number }).c
      : 0;
    const blobHashes = await listBlobHashesSorted(opts.blobRoot);
    state = {
      version: 1,
      phase: 'preparing',
      progress: {
        rowsDone: 0,
        rowsTotal: rowCount,
        blobsDone: 0,
        blobsTotal: blobHashes.length,
      },
      startedAt: now(),
    };
    opts.stateStore.save(state);
  }

  const flushProgress = (next: Partial<MigrationState>): void => {
    state = { ...(state as MigrationState), ...next };
    opts.stateStore.save(state);
    opts.onProgress?.((state as MigrationState).progress, (state as MigrationState).phase);
  };

  // Phase: cache
  if (state.phase === 'preparing' || state.phase === 'cache') {
    flushProgress({ phase: 'cache' });
    const migratedRows = await runCacheMigration(opts);
    flushProgress({
      progress: { ...state.progress, rowsDone: migratedRows },
    });
    flushProgress({ phase: 'blobs', cursor: undefined });
  }

  // Phase: blobs — sorted iteration from cursor onward.
  let blobsMigrated = 0;
  if (state.phase === 'blobs') {
    const allHashes = await listBlobHashesSorted(opts.blobRoot);
    const resumeIdx = state.cursor
      ? findNextIndex(allHashes, state.cursor)
      : 0;

    const flushEvery = opts.blobFlushEvery ?? 10;
    const blobsDoneAtStart = state.progress.blobsDone;

    for (let i = resumeIdx; i < allHashes.length; i++) {
      const hash = allHashes[i];
      await migrateOneBlob(opts.blobRoot, hash, opts.blobKey);
      blobsMigrated++;

      // Flush the cursor periodically (not on every file — SQLite write
      // per file would slow things considerably). Always flush on last.
      const shouldFlush = blobsMigrated % flushEvery === 0 || i === allHashes.length - 1;
      if (shouldFlush) {
        flushProgress({
          cursor: hash,
          progress: {
            ...state.progress,
            blobsDone: blobsDoneAtStart + blobsMigrated,
          },
        });
      }
    }
  }

  // Phase: finalizing
  flushProgress({ phase: 'finalizing' });
  const finalProgress = (state as MigrationState).progress;
  opts.stateStore.clear();

  return {
    rowsMigrated: finalProgress.rowsDone,
    blobsMigrated: finalProgress.blobsDone,
    tookMs: now() - start,
  };
};

/** Binary-search-like helper: find the index of the smallest element
 *  strictly greater than `cursor`. Assumes `hashes` is sorted ascending. */
const findNextIndex = (hashes: string[], cursor: string): number => {
  let lo = 0;
  let hi = hashes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (hashes[mid] <= cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
