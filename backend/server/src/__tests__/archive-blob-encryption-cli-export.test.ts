/* Archive blob-encryption fix — OFFLINE CLI export for ENCRYPTED servers.
 *
 * Phase 2 deferred the offline CLI (`recued-server archive export`) on an
 * encrypted server: it had no live KeyManager, so it refused rather than
 * archive ciphertext. This closes that gap — `cmdExport` now derives the
 * realm's `blob-store` sub-DEK from the LIVE bundle sidecar + recovery key
 * (the SAME `deriveBlobStoreKey` restore uses), so an
 * encrypted server's cache/memory blobs decrypt into the archive as plaintext
 * and restore re-encrypts them under the restored realm's (identical) key.
 *
 * These drive the REAL cmdArchive → exportArchive + applyRestore + blob-store
 * + crypto, no mocks. The capstone is the full CLI export→restore round-trip
 * on an encrypted realm. See internal design notes (deferred #1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  generateRecoveryKey,
  generateServerKey,
  createServerBundle,
  deriveSubDEK,
} from '@recued/crypto';

import { cmdArchive, type ArchiveCommandDeps } from '../commands/archive.js';
import { applyRestore, deriveBlobStoreKey } from '../archive/archive-restore.js';
import { createBlobStore, createEncryptedBlobStore } from '../storage/blob-store.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { openDatabase } from '../open-database.js';
import { deriveDatabaseKey } from '../database-encryption.js';

const FIXED_NOW = 1_700_000_000_000;
const dirs: string[] = [];
const newDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

const pathFor = (root: string, hash: string): string =>
  join(root, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

/** Stand up a stopped ENCRYPTED server on disk: a D-212 sidecar carrying the
 *  server bundle + a db carrying cache/memory blob refs, with matching encrypted
 *  blobs in the posture-split CAS roots. Returns the CLI deps, the recovery key
 *  as the CLI takes it (64-char hex), and everything needed to verify a restore.
 *  Mirrors the live layout: `cache_entries.blob_hash` → `cache_blobs`,
 *  `user_memory.$.blob_hash` → `memory_blobs`, `shared_store.blob_hash` →
 *  encrypted `blobs`. */
const makeEncryptedServer = async () => {
  const { mnemonic, entropy } = generateRecoveryKey();
  const recoveryHex = Buffer.from(entropy).toString('hex'); // what the CLI --key takes
  const { bundle, masterDEK } = await createServerBundle({
    recoveryKey: mnemonic,
    serverKey: generateServerKey(),
  });
  const blobKey = deriveSubDEK(masterDEK, 'blob-store');
  const databaseKey = deriveDatabaseKey(masterDEK);
  masterDEK.fill(0);

  const dataDir = newDir('cli-enc-data-');
  const outDir = newDir('cli-enc-out-');
  const dbPath = join(dataDir, 'recued-server.db');

  // Every production CAS root is encrypted under the same realm sub-DEK.
  const cachePlaintext = randomBytes(80_000); // > 64 KB → multi-chunk stream
  const memoryPlaintext = randomBytes(70_000);
  const sharedPlaintext = randomBytes(3_000);
  const cacheHash = await createEncryptedBlobStore(join(dataDir, 'cache_blobs'), () => blobKey).put(cachePlaintext);
  const memoryHash = await createEncryptedBlobStore(join(dataDir, 'memory_blobs'), () => blobKey).put(memoryPlaintext);
  const sharedHash = await createEncryptedBlobStore(join(dataDir, 'blobs'), () => blobKey).put(sharedPlaintext);

  const db = await openDatabase(dbPath, { databaseKey });
  databaseKey.fill(0);
  db.exec(`
    CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);
    CREATE TABLE user_memory (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE shared_store (key TEXT PRIMARY KEY, blob_hash TEXT);
  `);
  createServerBundleStore(dbPath).save(bundle);
  db.prepare(`INSERT INTO cache_entries (key, blob_hash) VALUES (?, ?)`).run('c1', cacheHash);
  db.prepare(`INSERT INTO user_memory (key, data) VALUES (?, ?)`)
    .run('m1', JSON.stringify({ blob_hash: memoryHash, kind: 'note' }));
  db.prepare(`INSERT INTO shared_store (key, blob_hash) VALUES (?, ?)`).run('s1', sharedHash);
  db.close(); // cmdExport opens its OWN handle from dbPath

  const deps: ArchiveCommandDeps = { dbPath, configPath: null, dataPath: dataDir, serverVersion: '0.2.0' };
  return {
    deps, recoveryHex, blobKey, dataDir, outDir,
    cachePlaintext, cacheHash, memoryPlaintext, memoryHash, sharedPlaintext, sharedHash,
  };
};

describe('archive export CLI — ENCRYPTED server (offline blob export)', () => {
  it('exports an encrypted server and the blobs round-trip through restore', async () => {
    const s = await makeEncryptedServer();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const dest = join(s.outDir, 'enc.recued.archive');
    // The CLI derives the blob key from the db-adjacent bundle sidecar.
    await cmdArchive(s.deps, ['export', dest, `--key=${s.recoveryHex}`]);
    expect(existsSync(dest)).toBe(true);

    // Restore into a fresh data dir. Restore re-derives the SAME blob key from
    // the archive's own sidecar record + the recovery key.
    const tgt = newDir('cli-enc-restore-');
    const tgtDbPath = join(tgt, 'recued-server.db');
    const res = await applyRestore(
      { dbPath: tgtDbPath, dataPath: tgt, configPath: null },
      { archivePath: dest, recoveryKey: Buffer.from(s.recoveryHex, 'hex'), consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    );
    expect(res.blob_count).toBe(3);
    expect(createServerBundleStore(tgtDbPath).load()).not.toBeNull();

    // Cross-machine recovery is complete, not merely readable while the CLI
    // still holds the mnemonic: restore rewrapped the same Master DEK to a new
    // destination keyfile, so ordinary keyfile-only boot opens the database.
    const rebooted = await openDatabase(tgtDbPath, {
      readonly: true,
      fileMustExist: true,
      keyEnvironment: {},
    });
    try {
      expect(rebooted.prepare('SELECT blob_hash FROM cache_entries WHERE key = ?').pluck().get('c1'))
        .toBe(s.cacheHash);
    } finally {
      rebooted.close();
    }

    // Cache blob → cache_blobs, decrypts to the original, ciphertext at rest.
    const tgtCache = createEncryptedBlobStore(join(tgt, 'cache_blobs'), () => s.blobKey);
    expect((await tgtCache.get(s.cacheHash))!.equals(s.cachePlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'cache_blobs'), s.cacheHash)).equals(s.cachePlaintext)).toBe(false);

    // Memory blob → its OWN memory_blobs root (not cache_blobs), same posture.
    const tgtMemory = createEncryptedBlobStore(join(tgt, 'memory_blobs'), () => s.blobKey);
    expect((await tgtMemory.get(s.memoryHash))!.equals(s.memoryPlaintext)).toBe(true);
    expect(await tgtCache.has(s.memoryHash)).toBe(false);

    // Shared blob → encrypted historical `blobs` root.
    const tgtShared = createEncryptedBlobStore(join(tgt, 'blobs'), () => s.blobKey);
    expect((await tgtShared.get(s.sharedHash))!.equals(s.sharedPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'blobs'), s.sharedHash)).equals(s.sharedPlaintext)).toBe(false);
  });

  it('refuses with an operator-facing message on a WRONG recovery key', async () => {
    const s = await makeEncryptedServer();
    // A DIFFERENT valid recovery key — unwrapping the Master DEK fails (GCM),
    // so the CLI refuses rather than archive undecryptable ciphertext.
    const wrongHex = Buffer.from(generateRecoveryKey().entropy).toString('hex');
    const dest = join(s.outDir, 'wrong.recued.archive');
    await expect(cmdArchive(s.deps, ['export', dest, `--key=${wrongHex}`]))
      .rejects.toThrow(/could not derive this server's database encryption key/);
    // Nothing was written (it fails before exportArchive touches the dest).
    expect(existsSync(dest)).toBe(false);
  });

  it('--no-blobs still requires the correct key for the encrypted database', async () => {
    const s = await makeEncryptedServer();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // `--no-blobs` skips only the CAS key derivation. The full-file encrypted
    // SQLite snapshot must still be opened under the restored realm's key.
    const wrongHex = Buffer.from(generateRecoveryKey().entropy).toString('hex');
    const dest = join(s.outDir, 'db-only.recued.archive');
    await expect(cmdArchive(s.deps, ['export', dest, `--key=${wrongHex}`, '--no-blobs']))
      .rejects.toThrow(/could not derive this server's database encryption key/);
    expect(existsSync(dest)).toBe(false);

    await cmdArchive(s.deps, ['export', dest, `--key=${s.recoveryHex}`, '--no-blobs']);
    expect(existsSync(dest)).toBe(true);
  });
});

describe('archive export CLI — legacy KEYLESS server', () => {
  it('refuses blob export instead of treating a production root as plaintext', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dataDir = newDir('cli-keyless-data-');
    const outDir = newDir('cli-keyless-out-');
    const dbPath = join(dataDir, 'recued-server.db');

    // Keyless realm: no server bundle, plaintext CAS roots.
    const cachePlaintext = randomBytes(5_000);
    const cacheHash = await createBlobStore(join(dataDir, 'cache_blobs')).put(cachePlaintext);

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);
    `);
    db.prepare(`INSERT INTO cache_entries (key, blob_hash) VALUES (?, ?)`).run('c1', cacheHash);
    db.close();

    const deps: ArchiveCommandDeps = { dbPath, configPath: null, dataPath: dataDir, serverVersion: '0.2.0' };
    const recoveryHex = Buffer.alloc(32, 7).toString('hex'); // arbitrary for a keyless realm
    const dest = join(outDir, 'keyless.recued.archive');
    await expect(cmdArchive(deps, ['export', dest, `--key=${recoveryHex}`]))
      .rejects.toThrow(/blob-store: locked/);
    expect(existsSync(dest)).toBe(false);

    // Database-only export remains available because it never reads a CAS root.
    await cmdArchive(deps, ['export', dest, `--key=${recoveryHex}`, '--no-blobs']);
    expect(existsSync(dest)).toBe(true);
  });
});

describe('deriveBlobStoreKey — shared sidecar/legacy derivation (fail-closed)', () => {
  const mkDb = (write: (db: Database.Database) => void): Database.Database => {
    const db = new Database(join(newDir('derive-'), 'x.db'));
    write(db);
    return db;
  };

  it('derives the EXACT blob-store sub-DEK from the server bundle + recovery entropy', async () => {
    const { mnemonic, entropy } = generateRecoveryKey();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey: mnemonic, serverKey: generateServerKey() });
    const db = mkDb((d) => {
      d.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    });
    try {
      const key = await deriveBlobStoreKey({
        db,
        serverBundle: bundle,
        recoveryEntropy: Buffer.from(entropy),
      });
      // Byte-identical to what the live/post-restore server derives.
      expect(Buffer.from(key!).equals(Buffer.from(deriveSubDEK(masterDEK, 'blob-store')))).toBe(true);
    } finally { db.close(); }
  });

  it('returns null for a KEYLESS realm (server_config present, no bundle row)', async () => {
    const db = mkDb((d) => d.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`));
    try {
      expect(await deriveBlobStoreKey({
        db,
        serverBundle: null,
        recoveryEntropy: Buffer.from(generateRecoveryKey().entropy),
      })).toBeNull();
    } finally { db.close(); }
  });

  it('returns null when server_config is entirely absent (older schema)', async () => {
    const db = mkDb((d) => d.exec(`CREATE TABLE something_else (k TEXT)`));
    try {
      expect(await deriveBlobStoreKey({
        db,
        serverBundle: null,
        recoveryEntropy: Buffer.from(generateRecoveryKey().entropy),
      })).toBeNull();
    } finally { db.close(); }
  });

  it('FAILS CLOSED (throws) when server_config exists but is UNREADABLE — never a silent keyless', async () => {
    // A server_config table missing the `value` column makes the config SELECT
    // throw. The OLD `catch { return null }` turned that into a false "keyless"
    // → an encrypted realm would archive ciphertext. It must now PROPAGATE.
    const db = mkDb((d) => d.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY)`));
    try {
      await expect(deriveBlobStoreKey({
        db,
        serverBundle: null,
        recoveryEntropy: Buffer.from(generateRecoveryKey().entropy),
      })).rejects.toThrow();
    } finally { db.close(); }
  });
});
