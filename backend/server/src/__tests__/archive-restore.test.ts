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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createServerBundle,
  deriveSubDEK,
  generateRecoveryKey,
  generateServerKey,
  serverBundleToJSON,
} from '@recued/crypto';

import { exportArchive } from '../archive/archive-export.js';
import type { ImportOptions } from '../archive/archive-import.js';
import type { DisplacedBlob } from '../archive/archive-restore.js';
import {
  applyRestore,
  commitStagedRestore,
  overlaySingleBlobFile,
  reclaimDisplacedBlobs,
  rollBackDisplacedBlobs,
  selectParkToRestore,
  stageRestore,
} from '../archive/archive-restore.js';
import { restoreProvenanceMarkerPath } from '../archive/restore-provenance.js';
import { createBlobStore, createEncryptedBlobStore } from '../storage/blob-store.js';
import { cmdArchive } from '../commands/archive.js';
import { resolveServerBundlePath } from '../server-bundle-store.js';
import { prepareServerBundleSwap } from '../archive/server-bundle-swap.js';
import { deriveDatabaseKey } from '../database-encryption.js';
import { openDatabase } from '../open-database.js';

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
  blobKey?: Buffer;
}

/** Seed a source data dir (db with a known row + optional config + blobs)
 *  and export it to a real `.recued.archive`. Returns the archive + key. */
const buildArchive = async (
  byte: number,
  opts: {
    withConfig?: boolean;
    blobs?: string[];
    passportJson?: string;
    serverVaultBundleJson?: string;
  } = {},
): Promise<BuiltArchive> => {
  const srcDir = newDir();
  let key = mkKey(byte);
  const srcDbPath = join(srcDir, 'src.db');
  let blobKey: Buffer | undefined;
  let serverVaultBundleJson = opts.serverVaultBundleJson;
  let db: Database.Database;
  if (opts.blobs?.length && serverVaultBundleJson === undefined) {
    const recovery = generateRecoveryKey();
    key = Buffer.from(recovery.entropy);
    const { bundle, masterDEK } = await createServerBundle({
      recoveryKey: recovery.mnemonic,
      serverKey: generateServerKey(),
    });
    const databaseKey = deriveDatabaseKey(masterDEK);
    blobKey = Buffer.from(deriveSubDEK(masterDEK, 'blob-store'));
    masterDEK.fill(0);
    db = await openDatabase(srcDbPath, { databaseKey });
    databaseKey.fill(0);
    serverVaultBundleJson = serverBundleToJSON(bundle);
  } else {
    db = new Database(srcDbPath);
  }
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
    if (!blobKey) throw new Error('blob fixture requires a realm blob key');
    blobStore = createEncryptedBlobStore(join(srcDir, 'blobs'), () => blobKey!);
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
    ...(serverVaultBundleJson !== undefined
      ? { serverVaultBundleJson }
      : {}),
  });
  db.close();
  return { archivePath, key, blobHashes, ...(blobKey ? { blobKey } : {}) };
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
    const restoredDb = await openDatabase(dbPath, {
      readonly: true,
      fileMustExist: true,
      keyEnvironment: {},
    });
    try {
      expect(restoredDb.prepare('SELECT v FROM example WHERE k = ?').pluck().get('hello'))
        .toBe('world');
    } finally {
      restoredDb.close();
    }

    // blobs restored + content-address identity (get-by-hash returns source bytes)
    const tgtBlobs = createEncryptedBlobStore(join(tgt, 'blobs'), () => built.blobKey!);
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

  /** This case used to assert the OPPOSITE — that a keyless archive clears
   *  the encrypted realm's sidecar and proceeds. That is the downgrade: the
   *  live database ends up plaintext, silently, and the wire manifest carries
   *  no encryption-posture field for a dry-run or the UI to warn on. Slice 4
   *  refused the same thing for a BLOB-bearing archive; the db-only case slipped
   *  through because the refusal sat behind a blob-only code path.
   *
   *  Keeping the sidecar instead of refusing is not the alternative — a
   *  plaintext db paired with an encrypted realm's bundle fails closed at the
   *  next open, so that would brick the install rather than save it. The
   *  legitimate replace-and-back-up path (an ENCRYPTED archive onto an
   *  encrypted realm) is covered in `server-vault-bundle-swap.test.ts`. */
  it('refuses a keyless archive when the realm it would replace is encrypted', async () => {
    const built = await buildArchive(0x21);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const bundlePath = resolveServerBundlePath(dbPath);
    writeFileSync(bundlePath, 'old-encrypted-realm-bundle');

    await expect(
      applyRestore(
        { dbPath, dataPath: tgt, configPath: null },
        impOpts(built),
        { now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(/D212_REALM_DOWNGRADE_REFUSED/);

    // The realm is left exactly as it was — nothing swapped, nothing cleared.
    expect(readFileSync(bundlePath, 'utf8')).toBe('old-encrypted-realm-bundle');
    expect(existsSync(dbPath)).toBe(false);
  });

  /** ⛔ …and it still refuses when the realm's sidecar is not at its live path.
   *
   *  The refusal above asks one question — does the bundle sidecar exist? — and
   *  an interrupted swap can make the honest answer "no" about an encrypted
   *  realm: `commitPreparedServerBundleSwap` moves the live bundle to its backup
   *  name a beat before the db commit point, so a kill in between leaves the
   *  realm encrypted with its sidecar parked. `applyRestore` used to stream the
   *  whole archive and evaluate the gate BEFORE anything reconciled that
   *  journal, so the gate saw a bare directory, passed, and the keyless archive
   *  committed — leaving the realm plaintext. Reconciling first is the fix, and
   *  it has to be first for a second reason too: once our own overlay has parked
   *  blobs in the same CAS, an older transaction's rollback cannot be told apart
   *  from ours. */
  it('refuses a keyless archive when the encrypted realm is mid-swap, its bundle parked', async () => {
    const built = await buildArchive(0x24);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const bundlePath = resolveServerBundlePath(dbPath);

    // Stage an interrupted swap, then kill it in the one window that parks the
    // pair: old db + bundle moved aside, staged db not yet renamed on.
    writeFileSync(dbPath, 'encrypted-realm-db');
    writeFileSync(bundlePath, 'old-encrypted-realm-bundle');
    const stagingPath = `${dbPath}.staging-${'b'.repeat(16)}`;
    writeFileSync(stagingPath, 'interrupted-staged-db');
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: '2023-11-14T22-13-20-000Z-feedface',
      nextBundle: Buffer.from('interrupted-next-bundle'),
    });
    renameSync(dbPath, prepared.dbBackupPath);
    renameSync(bundlePath, prepared.bundleBackupPath);
    // The state the gate used to be fooled by: no bundle at the live path.
    expect(existsSync(bundlePath)).toBe(false);
    expect(existsSync(prepared.bundleBackupPath)).toBe(true);

    await expect(
      applyRestore(
        { dbPath, dataPath: tgt, configPath: null },
        impOpts(built),
        { now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(/D212_REALM_DOWNGRADE_REFUSED/);

    // Reconciled back to the pre-swap realm, and still encrypted.
    expect(readFileSync(bundlePath, 'utf8')).toBe('old-encrypted-realm-bundle');
    expect(readFileSync(dbPath, 'utf8')).toBe('encrypted-realm-db');
    expect(existsSync(prepared.markerPath)).toBe(false);
  });

  /** ⛔ An unretired journal must STOP a new restore, not merely fail it late.
   *
   *  The journal keeps its marker when a park could not be resolved, so the next
   *  boot can re-decide with the verdict still attached. But `reconcileServer-
   *  BundleSwap` still reports `completed`/`rolled_back` — the REPAIR did
   *  happen — and `applyRestore` read that as "settled" and streamed a whole
   *  archive anyway. `prepareServerBundleSwap` then refused (correctly) on the
   *  surviving marker, and the catch, seeing *a* marker, preserved the staging
   *  as if it were our own recovery evidence. Net result: a leaked staging db
   *  and, worse, this restore's blob overlay left in the CAS with its parks
   *  un-rolled-back — under the OLD database, which still references them. */
  it('refuses to start a restore while an earlier journal is unretired', async () => {
    const built = await buildArchive(0x25);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    writeFileSync(dbPath, 'surviving-old-db');

    // A park the reclaim cannot resolve: the shard directory is read-only, so
    // both the unlink and the rename fail. This is what retains the marker.
    const shard = join(tgt, 'blobs', 'objects', 'ab');
    mkdirSync(shard, { recursive: true });
    const objectPath = join(shard, 'cdef.bin');
    writeFileSync(objectPath, 'archive-version-of-the-object');
    writeFileSync(`${objectPath}.pre-restore-000000000-aaaaaa`, 'pre-restore-original');

    // A committed-shape journal: marker present, staged db already gone.
    const stagingPath = `${dbPath}.staging-${'c'.repeat(16)}`;
    writeFileSync(stagingPath, 'staged');
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: '2023-11-14T22-13-20-000Z-0badcafe',
    });
    rmSync(stagingPath);

    chmodSync(shard, 0o500);
    try {
      await expect(
        applyRestore(
          { dbPath, dataPath: tgt, configPath: null },
          impOpts(built),
          { now: () => FIXED_NOW },
        ),
        // ⚠ Matched on the REMEDY text, not just the code. `prepareServerBundle-
        // Swap` raises the same code when it refuses the surviving marker AFTER
        // the stream — so asserting the code alone passes either way and proves
        // nothing about refusing early.
      ).rejects.toThrow(/could not be resolved/);

      // Refused BEFORE streaming: nothing of this restore exists on disk.
      expect(readFileSync(dbPath, 'utf8')).toBe('surviving-old-db');
      // The staged-db temps specifically — NOT `.restore-server-bundle-swap
      // .json`, which is the surviving marker and is supposed to be here.
      const leaked = readdirSync(tgt).filter((f) => /\.restore-[0-9a-f]{16}\.tmp$/.test(f));
      expect(leaked).toEqual([]);
      // The earlier journal is untouched — still there for the boot that can
      // finish it, not silently consumed by a restore that had no business
      // starting.
      expect(existsSync(prepared.markerPath)).toBe(true);
    } finally {
      chmodSync(shard, 0o700);
    }
  });

  /** Config is written BEFORE the journaled pair swap, because it is
   *  independent of it. A swap that then FAILS left the archive's config live
   *  over a database that was never replaced — a mismatched pair the operator
   *  never asked for and gets no report of, since the call throws.
   *
   *  ⚠ Driven through the ONLINE pair, deliberately. Offline, every reachable
   *  refusal fires inside `streamRestoreInto`, i.e. BEFORE `writeConfigRecord`
   *  ever runs — a test written there passes without touching the code it
   *  claims to cover. `commitStagedRestore` is where a refusal genuinely lands
   *  after the config write: the posture gate ran back at stage time, so the
   *  realm can acquire its sidecar in between. */
  const stagedThenRefused = async (
    tgt: string,
    configPath: string,
    byte: number,
  ): Promise<void> => {
    const built = await buildArchive(byte, { withConfig: true });
    const dbPath = join(tgt, 'recued-server.db');
    writeFileSync(dbPath, 'live-realm-db');

    const staged = await stageRestore(
      { dbPath, dataPath: tgt, configPath },
      impOpts(built),
    );
    // The realm becomes encrypted after staging, so the commit's act-site
    // invariant refuses a keyless swap that would drop the sidecar.
    writeFileSync(resolveServerBundlePath(dbPath), 'sidecar-arrived-after-stage');

    await expect(
      commitStagedRestore({ dbPath, dataPath: tgt, configPath }, staged, {
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(/D212_REALM_DOWNGRADE_REFUSED/);
  };

  it('puts config.toml back when the swap is refused after it was written', async () => {
    const tgt = newDir();
    const configPath = join(tgt, 'config.toml');
    writeFileSync(configPath, '[bootstrap]\nbind_port = 9999\n');

    await stagedThenRefused(tgt, configPath, 0x26);

    // The operator's config is theirs again — not the archive's.
    expect(readFileSync(configPath, 'utf8')).toContain('bind_port = 9999');
  });

  it('removes a config the failed restore introduced where there was none', async () => {
    const tgt = newDir();
    const configPath = join(tgt, 'config.toml');
    expect(existsSync(configPath)).toBe(false);

    await stagedThenRefused(tgt, configPath, 0x27);

    // Nothing was there before; nothing is there now. "Restore the backup" has
    // to cover the no-backup case too, or the realm keeps a config it never had.
    expect(existsSync(configPath)).toBe(false);
  });

  it('a keyless archive still restores onto a keyless realm', async () => {
    const built = await buildArchive(0x21);
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');

    const res = await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      impOpts(built),
      { now: () => FIXED_NOW },
    );

    expect(res.restored_at).toBe(FIXED_NOW);
    expect(existsSync(resolveServerBundlePath(dbPath))).toBe(false);
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

    const store = createEncryptedBlobStore(blobsRoot, () => built.blobKey!);
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

  it('rejects a malformed server-bundle record before swapping even with no blobs', async () => {
    const built = await buildArchive(0x22, { serverVaultBundleJson: '{}' });
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');
    const sentinel = new Database(dbPath);
    sentinel.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
    sentinel.prepare('INSERT INTO example VALUES (?, ?)').run('sentinel', 'survives');
    sentinel.close();

    await expect(
      applyRestore(
        { dbPath, dataPath: tgt, configPath: null },
        impOpts(built),
        { now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(/server-bundle/);

    expect(readRow(dbPath, 'sentinel')).toBe('survives');
    expect(existsSync(resolveServerBundlePath(dbPath))).toBe(false);
    expect(readdirSync(tgt).some((name) => name.includes('.restore-'))).toBe(false);
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

  it('--dry-run rejects a malformed server-bundle record', async () => {
    const built = await buildArchive(0x23, { serverVaultBundleJson: '{}' });
    const tgt = newDir();
    const dbPath = join(tgt, 'recued-server.db');

    await expect(
      cmdArchive(
        { dbPath, dataPath: tgt, configPath: null, serverVersion: '0.2.0' },
        ['import', built.archivePath, `--key=${built.key.toString('hex')}`, '--dry-run'],
      ),
    ).rejects.toThrow(/server-bundle/);

    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(tgt).some((name) => name.includes('.bak-'))).toBe(false);
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

describe('reclaimDisplacedBlobs — parks left by a killed restore', () => {
  /** A park is made with `link(2)`, which updates ctime and NOT mtime, so it
   *  inherits the mtime of the CAS object it aliases. An age-gated sweep
   *  therefore treats any park of a blob stored longer ago than the window as
   *  stale and deletes it — out from under the rollback that needs it. The CAS
   *  sweep now leaves parks entirely alone and boot reclaims them instead,
   *  where the swap journal says which way to go. */
  const parkFixture = (): { dataPath: string; objectPath: string; asidePath: string } => {
    const dataPath = newDir();
    const shard = join(dataPath, 'blobs', 'objects', 'ab');
    mkdirSync(shard, { recursive: true });
    const objectPath = join(shard, 'cdef.bin');
    const asidePath = `${objectPath}.pre-restore-0011223344`;
    writeFileSync(objectPath, 'ARCHIVE VERSION');
    writeFileSync(asidePath, 'PRE-RESTORE ORIGINAL');
    return { dataPath, objectPath, asidePath };
  };

  it('puts the original back when the swap did NOT commit', () => {
    const { dataPath, objectPath, asidePath } = parkFixture();

    const result = reclaimDisplacedBlobs(dataPath, false);

    expect(result).toEqual({ restored: 1, reaped: 0, complete: true });
    expect(readFileSync(objectPath, 'utf8')).toBe('PRE-RESTORE ORIGINAL');
    expect(existsSync(asidePath)).toBe(false);
  });

  it('drops the original once the swap HAS committed', () => {
    const { dataPath, objectPath, asidePath } = parkFixture();

    const result = reclaimDisplacedBlobs(dataPath, true);

    expect(result).toEqual({ restored: 0, reaped: 1, complete: true });
    expect(readFileSync(objectPath, 'utf8')).toBe('ARCHIVE VERSION');
    expect(existsSync(asidePath)).toBe(false);
  });

  it('restores the OLDEST park when a kill left two for one object', () => {
    // A malformed archive repeating a blob record parks twice: the first holds
    // the true pre-restore original, the second holds what the first overlay
    // wrote. After a kill only the filenames survive, so the sequence prefix is
    // what tells them apart — readdir order would pick arbitrarily.
    const dataPath = newDir();
    const shard = join(dataPath, 'blobs', 'objects', 'ab');
    mkdirSync(shard, { recursive: true });
    const objectPath = join(shard, 'cdef.bin');
    writeFileSync(objectPath, 'SECOND ARCHIVE VERSION');
    // Created newest-first on purpose: directory order must not be what decides
    // this, or the sequence prefix is doing nothing.
    writeFileSync(`${objectPath}.pre-restore-000000001-bbbbbb`, 'FIRST OVERLAY WROTE THIS');
    writeFileSync(`${objectPath}.pre-restore-000000000-aaaaaa`, 'TRUE ORIGINAL');

    const result = reclaimDisplacedBlobs(dataPath, false);

    expect(readFileSync(objectPath, 'utf8')).toBe('TRUE ORIGINAL');
    expect(result).toEqual({ restored: 1, reaped: 1, complete: true });
    expect(readdirSync(shard).filter((f) => f.includes('.pre-restore-'))).toEqual([]);
  });

  it('selects the oldest park regardless of the order it is handed', () => {
    // The integration case above cannot prove this: `readdir` returns sorted on
    // APFS, so the filesystem hides whether the ordering is real. Handing the
    // list in deliberately wrong order is what makes the assertion mean
    // something on every platform.
    const shuffled = [
      'cdef.bin.pre-restore-000000002-cccccc',
      'cdef.bin.pre-restore-000000000-aaaaaa',
      'cdef.bin.pre-restore-000000001-bbbbbb',
    ];
    expect(selectParkToRestore(shuffled)).toBe('cdef.bin.pre-restore-000000000-aaaaaa');
    expect(selectParkToRestore([])).toBeUndefined();
    // Sequence, not lexicographic accident: 10 must not sort before 2.
    expect(selectParkToRestore([
      'x.bin.pre-restore-000000010-zzzzzz',
      'x.bin.pre-restore-000000002-aaaaaa',
    ])).toBe('x.bin.pre-restore-000000002-aaaaaa');
  });

  it('leaves ordinary CAS objects untouched', () => {
    const dataPath = newDir();
    const shard = join(dataPath, 'cache_blobs', 'objects', 'ab');
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, 'cdef.bin'), 'live');
    writeFileSync(join(shard, '.tmp-abc'), 'in-flight put');

    expect(reclaimDisplacedBlobs(dataPath, false)).toEqual({ restored: 0, reaped: 0, complete: true });
    expect(existsSync(join(shard, 'cdef.bin'))).toBe(true);
    expect(existsSync(join(shard, '.tmp-abc'))).toBe(true);
  });

  // ⛔ A present-but-UNREADABLE shard is a subtree we could not inspect — any
  // park hiding in it is unresolved. Reporting `complete: true` there let the
  // swap journal drop its marker, stranding the park with no journal left to
  // decide rollback-vs-reap on the next boot. A transient EACCES/EIO must keep
  // the journal (`complete: false`), exactly like a per-park move failure.
  it('reports incomplete when a shard directory cannot be read', () => {
    const { dataPath } = parkFixture();
    const shard = join(dataPath, 'blobs', 'objects', 'ab');
    chmodSync(shard, 0o000); // present, but readdir throws EACCES
    try {
      const result = reclaimDisplacedBlobs(dataPath, false);
      expect(result.complete).toBe(false);
    } finally {
      chmodSync(shard, 0o700); // restore so afterEach can clean up
    }
  });

  it('reports incomplete when an objects root cannot be read', () => {
    const { dataPath } = parkFixture();
    const objectsDir = join(dataPath, 'blobs', 'objects');
    chmodSync(objectsDir, 0o000);
    try {
      expect(reclaimDisplacedBlobs(dataPath, false).complete).toBe(false);
    } finally {
      chmodSync(objectsDir, 0o700);
    }
  });

  it('a genuinely ABSENT objects tree is complete (nothing to reclaim)', () => {
    // The boundary the fix must not cross: no objects dir at all is not a
    // failure — it is a root this realm never wrote — so the journal may retire.
    const dataPath = newDir();
    expect(reclaimDisplacedBlobs(dataPath, false)).toEqual({ restored: 0, reaped: 0, complete: true });
  });
});

describe('rollBackDisplacedBlobs — unwinding a stack of parks', () => {
  it('reinstates the pre-restore original when one object was displaced twice', async () => {
    const tgt = newDir();
    const root = join(tgt, 'blobs');
    // Two realms, because that is the situation parking exists for: a CAS path
    // is the PLAINTEXT hash, so identical content collides across realms while
    // the ciphertext sitting at that path only opens under the key that wrote
    // it. The live realm's key first, then the archive's.
    const liveKey = mkKey(0x11);
    const archiveKey = mkKey(0x22);
    let key = liveKey;
    const store = createEncryptedBlobStore(root, () => key);

    const plaintext = Buffer.from('the surviving database still references this');
    const hash = await store.put(plaintext);
    const objectPath = join(root, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);
    const preRestore = readFileSync(objectPath);

    // One blob record carried twice: malformed, but nothing in the importer
    // rejects it and the archive HMAC still verifies. The second overlay parks
    // what the FIRST one wrote, so the two parks are a stack over one path.
    key = archiveKey;
    const srcPath = join(tgt, 'archive-blob.src');
    writeFileSync(srcPath, plaintext);
    const displaced: DisplacedBlob[] = [];
    await overlaySingleBlobFile(store, hash, srcPath, { root, into: displaced });
    await overlaySingleBlobFile(store, hash, srcPath, { root, into: displaced });
    expect(displaced).toHaveLength(2);
    expect(readFileSync(objectPath).equals(preRestore)).toBe(false);

    rollBackDisplacedBlobs(displaced);

    // Byte-identical to what the live realm wrote. Unwinding in insertion order
    // instead puts the original back and then renames the FIRST overlay's bytes
    // over it, which both leaves the archive realm's ciphertext live and drops
    // the original inode's last link — unrecoverably.
    expect(readFileSync(objectPath).equals(preRestore)).toBe(true);
    key = liveKey;
    expect((await store.get(hash))!.equals(plaintext)).toBe(true);
    const shardDir = join(root, 'objects', hash.slice(0, 2));
    expect(readdirSync(shardDir).filter((f) => f.includes('.pre-restore-'))).toEqual([]);
  });

  /** ⛔ PARTIAL FAILURE must be per-object all-or-nothing. A stack is [oldest =
   *  true original, …intermediates]. The old flat reversed rename consumed the
   *  original (it lands last) even when an intermediate could not be resolved —
   *  stranding that intermediate as the ONLY survivor, so the next boot's
   *  reclaim (which picks the oldest survivor) restored the INTERMEDIATE over
   *  the object. The fix discards intermediates FIRST and restores the original
   *  ONLY if they all clear, so the original is never consumed prematurely.
   *
   *  The unresolvable intermediate is a DIRECTORY here — `unlinkSync` throws on
   *  it deterministically, standing in for any park a transient error strands. */
  const partialStackFixture = () => {
    const tgt = newDir();
    const shard = join(tgt, 'blobs', 'objects', 'ab');
    mkdirSync(shard, { recursive: true });
    const objectPath = join(shard, 'cdef.bin');
    writeFileSync(objectPath, 'ARCHIVE VERSION'); // the overlaid archive bytes
    const original = `${objectPath}.pre-restore-000000000-aaaaaa`;
    writeFileSync(original, 'TRUE ORIGINAL');
    const intermediate = `${objectPath}.pre-restore-000000001-bbbbbb`;
    mkdirSync(intermediate); // unremovable via unlink ⇒ its discard fails
    return { tgt, objectPath, original, intermediate };
  };

  it('rollback does NOT consume the original while an intermediate cannot be resolved', () => {
    const { tgt, objectPath, original, intermediate } = partialStackFixture();

    const complete = rollBackDisplacedBlobs([
      { objectPath, asidePath: original },
      { objectPath, asidePath: intermediate },
    ]);

    // Unresolved ⇒ keep the journal.
    expect(complete).toBe(false);
    // THE FIX: the true original is still on disk (NOT consumed), so a retry can
    // restore it. The old reversed rename consumed it here.
    expect(existsSync(original)).toBe(true);
    expect(readFileSync(objectPath, 'utf8')).toBe('ARCHIVE VERSION');

    // Retry once the obstruction clears: the ORIGINAL is restored — never the
    // intermediate, which the old path would have left as the sole survivor.
    rmSync(intermediate, { recursive: true });
    const r = reclaimDisplacedBlobs(tgt, false);
    expect(r.complete).toBe(true);
    expect(readFileSync(objectPath, 'utf8')).toBe('TRUE ORIGINAL');
    expect(existsSync(original)).toBe(false);
  });

  it('boot reclaim also preserves the original when an intermediate cannot be resolved', () => {
    const { tgt, objectPath, original } = partialStackFixture();

    // reclaim is the first responder here (boot after a kill), not rollback.
    const r = reclaimDisplacedBlobs(tgt, false);

    expect(r.complete).toBe(false);
    expect(existsSync(original)).toBe(true);
    expect(readFileSync(objectPath, 'utf8')).toBe('ARCHIVE VERSION');
  });
});
