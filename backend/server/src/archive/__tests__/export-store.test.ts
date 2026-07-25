/** M1 — export-store unit tests.
 *
 *  Pure filesystem hygiene over a tmpdir: the single-latest-slot evictor,
 *  the TTL sweep, the conservative size estimate, and the human formatter.
 *  No db, no crypto — just files + stamped mtimes.
 */

import { mkdtemp, rm, writeFile, mkdir, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_STAGING_TTL_MS,
  EXPORT_HEADROOM_BYTES,
  EXPORT_SUFFIX,
  archiveStagingName,
  estimateExportBytes,
  evictOtherExports,
  exportsDir,
  formatBytes,
  isArchiveStagingName,
  isGeneratedExportName,
  newExportPath,
  pruneExpiredExports,
  pruneStagedArchives,
} from '../export-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'export-store-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const BASE_MS = Date.parse('2026-04-21T10:11:12.500Z');

/** Write an RPC-GENERATED export slot file (name matches the generator)
 *  with an explicit mtime. The filename's stamp is fixed; uniqueness comes
 *  from the generator's random suffix. */
const makeGenExport = async (mtimeMs: number): Promise<string> => {
  await mkdir(exportsDir(root), { recursive: true });
  const path = newExportPath(root, BASE_MS);
  await writeFile(path, 'x');
  const secs = mtimeMs / 1000;
  await utimes(path, secs, secs);
  return path;
};

/** Write an arbitrarily-named file under exports/ (a user-staged restore
 *  archive, or the in-flight .db.tmp backup) with an explicit mtime. */
const makeRawFile = async (name: string, mtimeMs: number): Promise<string> => {
  await mkdir(exportsDir(root), { recursive: true });
  const path = join(exportsDir(root), name);
  await writeFile(path, 'x');
  const secs = mtimeMs / 1000;
  await utimes(path, secs, secs);
  return path;
};

const remainingNames = async (): Promise<string[]> => {
  const names = await readdir(exportsDir(root)).catch(() => [] as string[]);
  return names.sort();
};

describe('isGeneratedExportName', () => {
  it('matches the generator output + rejects user / temp names', () => {
    expect(isGeneratedExportName(basename(newExportPath(root, BASE_MS)))).toBe(true);
    expect(isGeneratedExportName(`my-restore${EXPORT_SUFFIX}`)).toBe(false);
    expect(isGeneratedExportName(`2026-backup${EXPORT_SUFFIX}`)).toBe(false);
    expect(isGeneratedExportName(`recued-foo${EXPORT_SUFFIX}`)).toBe(false);
    expect(isGeneratedExportName(`recued-2026-04-21T10-11-12-500Z-deadbeef${EXPORT_SUFFIX}.db.tmp`)).toBe(false);
  });
});

describe('newExportPath', () => {
  it('stamps a unique datetime-named archive under exports/', () => {
    const p = newExportPath(root, BASE_MS);
    expect(p.startsWith(join(exportsDir(root), 'recued-2026-04-21T10-11-12-500Z-'))).toBe(true);
    expect(p.endsWith(EXPORT_SUFFIX)).toBe(true);
  });

  it('never collides for two calls at the same instant (random suffix)', () => {
    expect(newExportPath(root, BASE_MS)).not.toBe(newExportPath(root, BASE_MS));
  });
});

describe('evictOtherExports', () => {
  it('keeps the just-written file, deletes strictly-older generated ones', async () => {
    const a = await makeGenExport(1_000);
    const b = await makeGenExport(2_000);
    const keep = await makeGenExport(3_000);

    const deleted = evictOtherExports(root, keep);

    expect(deleted.sort()).toEqual([a, b].sort());
    expect(await remainingNames()).toEqual([basename(keep)]);
  });

  it('never deletes a file strictly NEWER than keepPath (concurrent-export guard)', async () => {
    await makeGenExport(1_000); // `old` — must be evicted
    const keep = await makeGenExport(2_000);
    const newer = await makeGenExport(3_000); // a later export already landed

    evictOtherExports(root, keep);

    // `old` evicted; `newer` survives (a concurrent later export's output
    // must not be nuked); `keep` survives.
    expect(await remainingNames()).toEqual([basename(keep), basename(newer)].sort());
  });

  it('evicts a same-tick prior export (single-slot never strands a same-mtime duplicate)', async () => {
    await makeGenExport(2_000); // prior, same fs tick — must be evicted
    const keep = await makeGenExport(2_000);

    evictOtherExports(root, keep);

    expect(await remainingNames()).toEqual([basename(keep)]);
  });

  it('deletes nothing when keepPath is absent', async () => {
    const a = await makeGenExport(1_000);
    const deleted = evictOtherExports(root, newExportPath(root, BASE_MS)); // never written
    expect(deleted).toEqual([]);
    expect(await remainingNames()).toEqual([basename(a)]);
  });

  it('leaves user-staged restore archives + the in-flight .db.tmp untouched', async () => {
    const keep = await makeGenExport(3_000);
    const userArchive = await makeRawFile(`my-restore${EXPORT_SUFFIX}`, 1_000); // older, but not ours
    const tmp = await makeRawFile(`${basename(keep)}.db.tmp`, 1_000);

    evictOtherExports(root, keep);

    const names = await remainingNames();
    expect(names).toContain(basename(userArchive)); // user restore source untouched
    expect(names).toContain(basename(tmp)); // in-flight backup untouched
    expect(names).toContain(basename(keep));
  });
});

describe('pruneExpiredExports', () => {
  it('deletes generated archives older than the TTL, keeps fresh ones', async () => {
    const now = Date.parse('2026-06-25T00:00:00.000Z');
    const ttl = 7 * 24 * 60 * 60 * 1000;
    const fresh = await makeGenExport(now - 60_000); // 1 min old
    const stale = await makeGenExport(now - 8 * 24 * 60 * 60 * 1000); // 8 days

    const deleted = pruneExpiredExports(root, ttl, now);

    expect(deleted).toEqual([stale]);
    expect(await remainingNames()).toEqual([basename(fresh)]);
  });

  it('never sweeps a user-staged archive even when stale', async () => {
    const now = Date.parse('2026-06-25T00:00:00.000Z');
    const ttl = 7 * 24 * 60 * 60 * 1000;
    const userArchive = await makeRawFile(`old-backup${EXPORT_SUFFIX}`, now - 30 * 24 * 60 * 60 * 1000);

    const deleted = pruneExpiredExports(root, ttl, now);

    expect(deleted).toEqual([]);
    expect(await remainingNames()).toEqual([basename(userArchive)]);
  });

  it('is a no-op when exports/ does not exist', () => {
    expect(pruneExpiredExports(root, 1000, Date.now())).toEqual([]);
  });
});

describe('estimateExportBytes', () => {
  it('budgets 2x db + headroom with no blobs', () => {
    expect(estimateExportBytes(1_000, 0)).toBe(2_000 + EXPORT_HEADROOM_BYTES);
  });

  it('adds the referenced blob bytes the caller passes in', () => {
    expect(estimateExportBytes(1_000, 1_200)).toBe(2_000 + 1_200 + EXPORT_HEADROOM_BYTES);
  });
});

describe('formatBytes', () => {
  it.each([
    [500, '500 B'],
    [2048, '2 KB'],
    [5 * 1024 * 1024, '5 MB'], // KB/MB render as integers; GB+ get one decimal
    [3 * 1024 * 1024 * 1024, '3.0 GB'],
    [Math.round(2.5 * 1024 * 1024 * 1024), '2.5 GB'],
  ])('formats %i as %s', (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });
});

describe('archive staging names (M4b.1)', () => {
  it('archiveStagingName is deterministic, staging-shaped, and NOT a generated export', () => {
    const name = archiveStagingName('up_abc');
    expect(archiveStagingName('up_abc')).toBe(name); // deterministic
    expect(name).toMatch(/^recued-upload-[0-9a-f]{32}\.recued\.archive$/);
    expect(isArchiveStagingName(name)).toBe(true);
    // Disjoint from the export GC + /ws/download surface (they gate on this).
    expect(isGeneratedExportName(name)).toBe(false);
    // Different upload_id → different name (per-upload staging, no collision).
    expect(archiveStagingName('up_def')).not.toBe(name);
  });

  it('isArchiveStagingName is EXACT — a prefix-sharing user file is not matched', () => {
    const real = archiveStagingName('up_1');
    expect(isArchiveStagingName(real)).toBe(true);
    // Near-misses a too-broad prefix predicate would have wrongly matched:
    for (const miss of [
      'recued-upload-notes.recued.archive', // non-hex body
      'recued-upload-abc.recued.archive', // too short
      `recued-upload-${'a'.repeat(33)}.recued.archive`, // too long
      `${real}.bak`, // trailing suffix
      'recued-upload-' + 'A'.repeat(32) + '.recued.archive', // uppercase hex
      'recued-2026-04-21T10-11-12-500Z-deadbeef.recued.archive', // a generated export
    ]) {
      expect(isArchiveStagingName(miss)).toBe(false);
    }
  });

  it('pruneStagedArchives reaps only EXPIRED staging files — fresh ones + exports + user files survive', async () => {
    await mkdir(exportsDir(root), { recursive: true });
    const now = BASE_MS;

    // One stale staged archive (older than TTL) + one fresh one.
    const stale = join(exportsDir(root), archiveStagingName('up_stale'));
    await writeFile(stale, Buffer.from('stale'));
    await utimes(stale, new Date(now - ARCHIVE_STAGING_TTL_MS - 1000), new Date(now - ARCHIVE_STAGING_TTL_MS - 1000));
    const fresh = join(exportsDir(root), archiveStagingName('up_fresh'));
    await writeFile(fresh, Buffer.from('fresh'));
    await utimes(fresh, new Date(now), new Date(now));

    // A generated export + a hand-placed user file — neither is staging-shaped.
    const gen = newExportPath(root, now);
    await writeFile(gen, Buffer.from('export'));
    await utimes(gen, new Date(now - ARCHIVE_STAGING_TTL_MS - 1000), new Date(now - ARCHIVE_STAGING_TTL_MS - 1000));
    const user = join(exportsDir(root), 'restore-source.recued.archive');
    await writeFile(user, Buffer.from('user'));
    await utimes(user, new Date(now - ARCHIVE_STAGING_TTL_MS - 1000), new Date(now - ARCHIVE_STAGING_TTL_MS - 1000));

    const deleted = pruneStagedArchives(root, ARCHIVE_STAGING_TTL_MS, now);
    expect(deleted.map((p) => basename(p))).toEqual([basename(stale)]);
    const left = (await readdir(exportsDir(root))).sort();
    expect(left).toEqual(
      [basename(fresh), basename(gen), basename(user)].sort(),
    );
  });
});
