/** Phase F (D-108) — archive RESTORE tests (write-into-`data_path`).
 *
 *  Companion to `archive-roundtrip.test.ts` (which proves export →
 *  import decrypt/verify). These prove the second half: `applyRestore`
 *  streaming a verified archive back into a stopped server's data dir,
 *  plus the CLI wiring through `cmdArchive`.
 *
 *  M4b.0: `applyRestore` now takes the archive PATH + key (an
 *  `ImportOptions`) and drives the streaming importer itself — there is no
 *  intermediate in-memory `ImportedRecords`. Real sqlite, real
 *  exportArchive, NO mocks — only the liveness probe + clock are injected.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import { exportArchive } from '../archive/archive-export.js';
import type { ImportOptions } from '../archive/archive-import.js';
import {
  applyRestore,
  commitStagedRestore,
  overlaySingleBlobFile,
  stageRestore,
} from '../archive/archive-restore.js';
import { restoreProvenanceMarkerPath } from '../archive/restore-provenance.js';
import { createBlobStore } from '../storage/blob-store.js';
import { cmdArchive } from '../commands/archive.js';

const mkKey = (byte: number): Buffer => Buffer.alloc(32, byte);
const FIXED_NOW = 1_700_000_000_000;

const dirs: string[] = [];
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'archive-restore-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

interface BuiltArchive {
  archivePath: string;
  key: Buffer;
  blobHashes: string[];
}

/** Seed a source data dir (db with a known row + optional config + blobs)
 *  and export it to a real `.recued.archive`. Returns the archive + key. */
const buildArchive = async (
  byte: number,
  opts: { withConfig?: boolean; blobs?: string[]; passportJson?: string } = {},
): Promise<BuiltArchive> => {
  const srcDir = newDir();
  const key = mkKey(byte);
  const srcDbPath = join(srcDir, 'src.db');
  const db = new Database(srcDbPath);
  db.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO example VALUES (?, ?)').run('hello', 'world');

  let configPath: string | undefined;
  if (opts.withConfig) {
    configPath = join(srcDir, 'config.toml');
    writeFileSync(configPath, '[bootstrap]\nbind_port = 7717\n');
  }

  let blobStore: ReturnType<typeof createBlobStore> | undefined;
  const blobHashes: string[] = [];
  if (opts.blobs?.length) {
    blobStore = createBlobStore(join(srcDir, 'blobs'));
    for (const payload of opts.blobs) {
      blobHashes.push(await blobStore.put(Buffer.from(payload)));
    }
  }

  const archivePath = join(srcDir, 'out.recued.archive');
  await exportArchive({
    destPath: archivePath,
    recoveryKey: key,
    db,
    configPath,
    blobs: blobStore,
    blobHashes,
    producerVersion: '0.2.0',
    ...(opts.passportJson !== undefined ? { passportJson: opts.passportJson } : {}),
  });
  db.close();
  return { archivePath, key, blobHashes };
};

/** The streaming-restore import options for a built archive. */
const impOpts = (built: BuiltArchive): ImportOptions => ({
  archivePath: built.archivePath,
  recoveryKey: built.key,
  consumerVersion: '0.2.0',
});

const readRow = (dbPath: string, k: string): string | undefined => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT v FROM example WHERE k = ?').get(k) as
      | { v: string }
      | undefined;
    return row?.v;
  } finally {
    db.close();
  }
};

/** Mirror of blob-store's private `pathFor` — used to plant a corrupt
 *  object at the exact on-disk path a restore will target. */
const blobObjectPath = (blobsRoot: string, hash: string): string =>
  join(blobsRoot, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

// ────────────────────────────────────────────────────────────────
// applyRestore — happy path
// ────────────────────────────────────────────────────────────────

describe('applyRestore', () => {
  it('restores db + config + blobs into a fresh data_path', async () => {
    const built = await buildArchive(1, {
      withConfig: true,
      blobs: ['blob-one', 'blob-two-longer-payload'],
    });

    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const configPath = join(tgt, 'config.toml');
    const res = await applyRestore(
      { dbPath, dataPath: tgt, configPath },
      impOpts(built),
      { now: () => FIXED_NOW },
    );

    // db row round-trips
    expect(existsSync(dbPath)).toBe(true);
    expect(readRow(dbPath, 'hello')).toBe('world');

    // blobs restored + content-address identity (get-by-hash returns source bytes)
    const tgtBlobs = createBlobStore(join(tgt, 'blobs'));
    expect(await tgtBlobs.has(built.blobHashes[0])).toBe(true);
    expect((await tgtBlobs.get(built.blobHashes[0]))?.toString('utf8')).toBe('blob-one');
    expect((await tgtBlobs.get(built.blobHashes[1]))?.toString('utf8')).toBe(
      'blob-two-longer-payload',
    );

    // config restored
    expect(readFileSync(configPath, 'utf8')).toContain('bind_port = 7717');

    // result shape
    expect(res.blob_count).toBe(2);
    expect(res.config_written).toBe(true);
    expect(res.db_backup_path).toBeNull(); // fresh target — nothing to back up
    expect(res.restored_at).toBe(FIXED_NOW);
    expect(res.db_bytes).toBeGreaterThan(0);
  });

  it('backs up an existing db + clears stale WAL/SHM before clobber', async () => {
    const built = await buildArchive(2);

    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    // Pre-existing db with a DIFFERENT marker row.
    const old = new Database(dbPath);
    old.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
    old.prepare('INSERT INTO example VALUES (?, ?)').run('old', 'state');
    old.close();
    // Stale WAL/SHM sidecars that must NOT survive next to the new db.
    writeFileSync(`${dbPath}-wal`, 'stale-wal-bytes');
    writeFileSync(`${dbPath}-shm`, 'stale-shm-bytes');

    const res = await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(built),
      { now: () => FIXED_NOW },
    );

    // old db preserved (not lost) at a .bak-<stamp> path, with its old row
    expect(res.db_backup_path).toMatch(/recued-server\.db\.bak-/);
    expect(existsSync(res.db_backup_path!)).toBe(true);
    expect(readRow(res.db_backup_path!, 'old')).toBe('state');

    // live db is the RESTORED one (source row present, old row gone)
    expect(readRow(dbPath, 'hello')).toBe('world');
    expect(readRow(dbPath, 'old')).toBeUndefined();

    // stale sidecars moved out of the live path, captured in backups
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(res.backups.some((b) => b.includes('recued-server.db-wal.bak-'))).toBe(true);
    expect(res.backups.some((b) => b.includes('recued-server.db-shm.bak-'))).toBe(true);
  });

  it('backs up an existing config before overwriting it', async () => {
    const built = await buildArchive(3, { withConfig: true });

    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const configPath = join(tgt, 'config.toml');
    writeFileSync(configPath, '[bootstrap]\nbind_port = 9999\n'); // old config

    const res = await applyRestore(
      { dbPath, dataPath: tgt, configPath },
      impOpts(built),
      { now: () => FIXED_NOW },
    );

    // new config landed
    expect(readFileSync(configPath, 'utf8')).toContain('bind_port = 7717');
    // old config preserved
    const cfgBak = res.backups.find((b) => b.includes('config.toml.bak-'));
    expect(cfgBak).toBeDefined();
    expect(readFileSync(cfgBak!, 'utf8')).toContain('bind_port = 9999');
  });

  it('skips config when configPath is null', async () => {
    const built = await buildArchive(4, { withConfig: true });

    const tgt = newDir();
    const res = await applyRestore(
      { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
      impOpts(built),
      { now: () => FIXED_NOW },
    );
    expect(res.config_written).toBe(false);
    // only the db landed — no config file anywhere in the dir
    expect(readdirSync(tgt).some((f) => f.endsWith('.toml'))).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────
  // Running-server guard
  // ──────────────────────────────────────────────────────────────

  it('refuses when a live server holds the instance lock; --force overrides', async () => {
    const built = await buildArchive(5);

    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    writeFileSync(
      join(tgt, 'recued-server.lock'),
      JSON.stringify({ pid: 4242, boot_at: 1, bind_port: 7717 }),
    );

    // Live holder → refuse, and write nothing (no db, no blobs dir).
    await expect(
      applyRestore({ dbPath, dataPath: tgt, configPath: null }, impOpts(built), {
        isProcessAlive: () => true,
      }),
    ).rejects.toThrow(/ARCHIVE_RESTORE_SERVER_LIVE/);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(tgt, 'blobs'))).toBe(false);

    // --force → proceed despite the live lock.
    const res = await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(built),
      { isProcessAlive: () => true, force: true },
    );
    expect(existsSync(dbPath)).toBe(true);
    expect(res.db_bytes).toBeGreaterThan(0);
  });

  it('ignores a stale lock (dead holder) without --force', async () => {
    const built = await buildArchive(6);

    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    writeFileSync(
      join(tgt, 'recued-server.lock'),
      JSON.stringify({ pid: 999_999, boot_at: 1, bind_port: 7717 }),
    );

    const res = await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(built),
      { isProcessAlive: () => false },
    );
    expect(existsSync(dbPath)).toBe(true);
    expect(res.db_bytes).toBeGreaterThan(0);
  });

  it('overlaySingleBlobFile rejects a source whose bytes do not content-address to the name', async () => {
    // The streaming restore can't materialize a forged blob the way the old
    // in-memory path could (mutating decoded records), so the blob-name-lies
    // invariant is exercised at its source: overlaySingleBlobFile refuses a
    // source file whose sha256 != the declared hash.
    const tgt = newDir();
    const store = createBlobStore(join(tgt, 'blobs'));
    const src = join(tgt, 'forged.tmp');
    writeFileSync(src, Buffer.from('not-that-hash'));
    await expect(
      overlaySingleBlobFile(store, 'deadbeef'.repeat(8), src),
    ).rejects.toThrow(/ARCHIVE_RESTORE_BLOB_HASH_MISMATCH/);
  });

  it('overlaySingleBlobFile refuses a traversal / non-hex blob name before any fs op', async () => {
    // A crafted archive could name a blob `blobs/../../victim`; the suffix
    // must be rejected before it reaches the CAS path builder.
    const tgt = newDir();
    const store = createBlobStore(join(tgt, 'blobs'));
    const src = join(tgt, 'x.tmp');
    writeFileSync(src, Buffer.from('x'));
    for (const bad of ['../../escape', 'blobs/x', 'DEADBEEF'.repeat(8), 'abc']) {
      await expect(
        overlaySingleBlobFile(store, bad, src),
      ).rejects.toThrow(/ARCHIVE_RESTORE_BLOB_HASH_MISMATCH/);
    }
  });

  it('overlaySingleBlobFile preserves a valid existing blob when the new write fails (no delete-before-put)', async () => {
    // Restore overlays into the LIVE CAS before the db swap, so a valid blob the
    // CURRENT db still references must NOT be deleted by an overlay that then
    // fails (the authoritative-but-atomic-replace contract). Plant a valid blob,
    // then overlay from an UNREADABLE source so the write fails.
    const tgt = newDir();
    const store = createBlobStore(join(tgt, 'blobs'));
    const bytes = Buffer.from('valid-existing-blob-bytes');
    const hash = await store.put(bytes);
    await expect(
      overlaySingleBlobFile(store, hash, join(tgt, 'does-not-exist.tmp')),
    ).rejects.toThrow();
    // The pre-existing valid blob survives the aborted overlay (not deleted).
    expect((await store.get(hash))?.equals(bytes)).toBe(true);
  });

  it('rewrites a pre-existing CORRUPT blob (authoritative restore)', async () => {
    const built = await buildArchive(10, { blobs: ['authoritative-blob-bytes'] });
    const hash = built.blobHashes[0];

    const tgt = newDir();
    const blobsRoot = join(tgt, 'blobs');
    // Plant a corrupt object at the exact hash path the restore targets.
    // blob-store.put() would dedup-skip it; restore must overwrite it.
    const corruptPath = blobObjectPath(blobsRoot, hash);
    mkdirSync(dirname(corruptPath), { recursive: true });
    writeFileSync(corruptPath, Buffer.from('CORRUPT-not-the-real-bytes'));

    await applyRestore(
      { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
      impOpts(built),
      { now: () => FIXED_NOW },
    );

    const store = createBlobStore(blobsRoot);
    expect((await store.get(hash))?.toString('utf8')).toBe('authoritative-blob-bytes');
  });

  it('does not clobber an earlier backup when the stamp clock collides', async () => {
    const built = await buildArchive(11);

    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const old = new Database(dbPath);
    old.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
    old.prepare('INSERT INTO example VALUES (?, ?)').run('gen', 'one');
    old.close();

    // Two restores under the SAME fixed clock → identical timestamp stamp.
    const res1 = await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(built),
      { now: () => FIXED_NOW },
    );
    const res2 = await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(built),
      { now: () => FIXED_NOW },
    );

    expect(res1.db_backup_path).not.toBeNull();
    expect(res2.db_backup_path).not.toBeNull();
    // Distinct backup paths despite the identical clock → no silent clobber.
    expect(res2.db_backup_path).not.toBe(res1.db_backup_path);
    expect(existsSync(res1.db_backup_path!)).toBe(true); // earlier backup survives
    expect(existsSync(res2.db_backup_path!)).toBe(true);
  });

  it('aborts without clobbering the live db on a wrong key', async () => {
    const built = await buildArchive(12);

    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const sentinel = new Database(dbPath);
    sentinel.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
    sentinel.prepare('INSERT INTO example VALUES (?, ?)').run('sentinel', 'survives');
    sentinel.close();

    await expect(
      applyRestore(
        { dbPath, dataPath: tgt, configPath: null },
        { archivePath: built.archivePath, recoveryKey: mkKey(99), consumerVersion: '0.2.0' },
        { now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(/ARCHIVE_INVALID_SIGNATURE/);

    // Live db untouched, no temp / backup debris left behind.
    expect(readRow(dbPath, 'sentinel')).toBe('survives');
    expect(readdirSync(tgt).some((f) => f.includes('.bak-'))).toBe(false);
    expect(readdirSync(tgt).some((f) => f.includes('.restore-'))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// CLI wiring through cmdArchive
// ────────────────────────────────────────────────────────────────

describe('cmdArchive import', () => {
  it('--dry-run verifies without writing or backing up (regression)', async () => {
    const built = await buildArchive(8);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    // Sentinel db that must stay byte-identical.
    const sentinel = new Database(dbPath);
    sentinel.exec('CREATE TABLE s (x TEXT)');
    sentinel.prepare('INSERT INTO s VALUES (?)').run('sentinel');
    sentinel.close();
    const before = readFileSync(dbPath);

    await cmdArchive(
      { dbPath, dataPath: tgt, configPath: null, serverVersion: '0.2.0' },
      ['import', built.archivePath, `--key=${built.key.toString('hex')}`, '--dry-run'],
    );

    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(readdirSync(tgt).some((f) => f.includes('.bak-'))).toBe(false);
  });

  it('non-dry-run restores into data_path and backs up the prior db', async () => {
    const built = await buildArchive(9);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const sentinel = new Database(dbPath);
    sentinel.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
    sentinel.prepare('INSERT INTO example VALUES (?, ?)').run('sentinel', 'value');
    sentinel.close();

    await cmdArchive(
      { dbPath, dataPath: tgt, configPath: null, serverVersion: '0.2.0' },
      ['import', built.archivePath, `--key=${built.key.toString('hex')}`],
    );

    // restored content present, prior db backed up
    expect(readRow(dbPath, 'hello')).toBe('world');
    const bak = readdirSync(tgt).find((f) => f.includes('recued-server.db.bak-'));
    expect(bak).toBeDefined();
    expect(readRow(join(tgt, bak!), 'sentinel')).toBe('value');
  });

  it('--force=false is honored as false against a live lock (strict parse)', async () => {
    const built = await buildArchive(13);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    // Live lock: our OWN pid is provably alive, so the real liveness probe
    // fires — no injection needed at the CLI layer.
    writeFileSync(
      join(tgt, 'recued-server.lock'),
      JSON.stringify({ pid: process.pid, boot_at: 1, bind_port: 7717 }),
    );
    const keyHex = built.key.toString('hex');
    const deps = { dbPath, dataPath: tgt, configPath: null, serverVersion: '0.2.0' };

    // --force=false must NOT bypass the guard (the loose parser would).
    await expect(
      cmdArchive(deps, ['import', built.archivePath, `--key=${keyHex}`, '--force=false']),
    ).rejects.toThrow(/ARCHIVE_RESTORE_SERVER_LIVE/);
    expect(existsSync(dbPath)).toBe(false);

    // bare --force bypasses.
    await cmdArchive(deps, ['import', built.archivePath, `--key=${keyHex}`, '--force']);
    expect(readRow(dbPath, 'hello')).toBe('world');
  });
});

// ────────────────────────────────────────────────────────────────
// commitStagedRestore — failure cleanup (import-latch race fix, part b)
// ────────────────────────────────────────────────────────────────

describe('commitStagedRestore failure cleanup', () => {
  it('removes the (nonce-named) staged db when the commit fails + rolls the original back', async () => {
    // A post-drain commit failure must NOT strand the staged db. Staging paths
    // are now nonce-named, so a leaked file would accumulate on every failed
    // restore (the old fixed path was self-limiting — the next stage overwrote
    // it). Force the commit to throw at the config-write step (its dir is a
    // regular FILE, so the atomic write can't create/use it) and assert the
    // staged db is gone + the original db rolled back into place.
    const built = await buildArchive(0x42, { withConfig: true });
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const live = new Database(dbPath);
    live.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
    live.prepare('INSERT INTO example VALUES (?, ?)').run('live', 'original');
    live.close();

    // A blocker FILE → its child config path can't be written (ENOTDIR).
    const blocker = join(tgt, 'blocker');
    writeFileSync(blocker, 'x');
    const targets = { dbPath, dataPath: tgt, configPath: join(blocker, 'config.toml') };

    const staged = await stageRestore(targets, impOpts(built));
    expect(existsSync(staged.stagingPath)).toBe(true);
    expect(staged.config).toBeDefined(); // archive carried a config → commit writes it

    await expect(
      commitStagedRestore(targets, staged, { now: () => FIXED_NOW }),
    ).rejects.toThrow();

    // The staged decrypted db was reclaimed (not leaked beside the live db) ...
    expect(existsSync(staged.stagingPath)).toBe(false);
    // ... and the original db is back in place, intact (commit aborted cleanly).
    expect(existsSync(dbPath)).toBe(true);
    expect(readRow(dbPath, 'live')).toBe('original');
  });
});

// ────────────────────────────────────────────────────────────────
// Restore-provenance marker wiring (M5 S1) — both commit paths stage the
// archive's embedded passport into a dataPath marker AFTER the swap, so the
// next boot can record the migration provenance.
// ────────────────────────────────────────────────────────────────

describe('restore provenance marker wiring (M5 S1)', () => {
  // The stager only embeds the passport bytes (it does not verify — the boot
  // commit does), so a recognisable JSON stand-in suffices for the wiring.
  const PASSPORT_JSON = JSON.stringify({
    passport_version: 'recued.passport.v1',
    profile: 'migration_full',
    passport_id: 'pp-wiring-1',
  });

  it('applyRestore stages a marker carrying the passport when the archive embeds one', async () => {
    const built = await buildArchive(0x51, { passportJson: PASSPORT_JSON });
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    await applyRestore({ dbPath, dataPath: tgt, configPath: null }, impOpts(built), {
      now: () => FIXED_NOW,
    });

    const markerPath = restoreProvenanceMarkerPath(tgt);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker.v).toBe(1);
    expect(marker.restored_at).toBe(FIXED_NOW);
    expect(marker.passport.passport_id).toBe('pp-wiring-1');
  });

  it('applyRestore writes no marker when the archive embeds no passport', async () => {
    const built = await buildArchive(0x52);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    await applyRestore({ dbPath, dataPath: tgt, configPath: null }, impOpts(built), {
      now: () => FIXED_NOW,
    });
    expect(existsSync(restoreProvenanceMarkerPath(tgt))).toBe(false);
  });

  it('a no-passport restore over a prior restore clears the stale marker (Codex S1 HIGH)', async () => {
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    // First committed restore from a WITH-passport archive → marker present.
    await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(await buildArchive(0x53, { passportJson: PASSPORT_JSON })),
      { now: () => FIXED_NOW },
    );
    expect(existsSync(restoreProvenanceMarkerPath(tgt))).toBe(true);
    // Second committed restore (no passport) before any boot → stale marker
    // must not survive to record the FIRST archive's lineage against this db.
    await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(await buildArchive(0x54)),
      { now: () => FIXED_NOW },
    );
    expect(existsSync(restoreProvenanceMarkerPath(tgt))).toBe(false);
  });

  it('commitStagedRestore stages the marker only AFTER the swap commits', async () => {
    const built = await buildArchive(0x55, { passportJson: PASSPORT_JSON });
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const targets = { dbPath, dataPath: tgt, configPath: null };

    const staged = await stageRestore(targets, impOpts(built));
    // Staging alone must not write the marker (the restore hasn't committed).
    expect(existsSync(restoreProvenanceMarkerPath(tgt))).toBe(false);

    await commitStagedRestore(targets, staged, { now: () => FIXED_NOW });
    const markerPath = restoreProvenanceMarkerPath(tgt);
    expect(existsSync(markerPath)).toBe(true);
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).passport.passport_id).toBe(
      'pp-wiring-1',
    );
  });

  it('a FAILED commitStagedRestore with a passport writes NO marker (no phantom provenance)', async () => {
    // The marker must be staged ONLY after the swap lands, never for a restore
    // that aborts. Force the commit to fail at the config write (its dir is a
    // FILE → ENOTDIR) with a passport-bearing archive, then assert no marker —
    // catches production logic that staged the marker before the swap/throw.
    const built = await buildArchive(0x56, { withConfig: true, passportJson: PASSPORT_JSON });
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const blocker = join(tgt, 'blocker');
    writeFileSync(blocker, 'x');
    const targets = { dbPath, dataPath: tgt, configPath: join(blocker, 'config.toml') };

    const staged = await stageRestore(targets, impOpts(built));
    expect(staged.passportBytes).toBeDefined(); // the archive really carried a passport
    await expect(
      commitStagedRestore(targets, staged, { now: () => FIXED_NOW }),
    ).rejects.toThrow();

    expect(existsSync(restoreProvenanceMarkerPath(tgt))).toBe(false);
  });

  it('a FAILED applyRestore with a passport writes NO marker (offline path)', async () => {
    const built = await buildArchive(0x57, { withConfig: true, passportJson: PASSPORT_JSON });
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const blocker = join(tgt, 'blocker');
    writeFileSync(blocker, 'x');
    await expect(
      applyRestore(
        { dbPath, dataPath: tgt, configPath: join(blocker, 'config.toml') },
        impOpts(built),
        { now: () => FIXED_NOW },
      ),
    ).rejects.toThrow();

    expect(existsSync(restoreProvenanceMarkerPath(tgt))).toBe(false);
  });
});
