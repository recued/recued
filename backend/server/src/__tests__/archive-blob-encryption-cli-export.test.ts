/* Archive blob-encryption fix — OFFLINE CLI export for ENCRYPTED servers.
 *
 * Phase 2 deferred the offline CLI (`recued-server archive export`) on an
 * encrypted server: it had no live KeyManager, so it refused rather than
 * archive ciphertext. This closes that gap — `cmdExport` now derives the
 * realm's `blob-store` sub-DEK straight from the LIVE db's server bundle +
 * the recovery key (the SAME `deriveBlobStoreKeyFromDb` restore uses), so an
 * encrypted server's cache/memory blobs decrypt into the archive as plaintext
 * and restore re-encrypts them under the restored realm's (identical) key.
 *
 * These drive the REAL cmdArchive → exportArchive + applyRestore + blob-store
 * + crypto, no mocks. The capstone is the full CLI export→restore round-trip
 * on an encrypted realm. See docs/archive-blob-encryption-fix.md (deferred #1).
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
  serverBundleToJSON,
  deriveSubDEK,
} from '@recued/crypto';

import { cmdArchive, type ArchiveCommandDeps } from '../commands/archive.js';
import { applyRestore, deriveBlobStoreKeyFromDb } from '../archive/archive-restore.js';
import { createBlobStore } from '../storage/blob-store.js';

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

/** Stand up a stopped ENCRYPTED server on disk: a db carrying the realm's
 *  `server_vault_bundle` + cache/memory blob refs, with the matching encrypted
 *  blobs in the posture-split CAS roots. Returns the CLI deps, the recovery key
 *  as the CLI takes it (64-char hex), and everything needed to verify a restore.
 *  Mirrors the live layout: `cache_entries.blob_hash` → `cache_blobs`,
 *  `user_memory.$.blob_hash` → `memory_blobs`, `shared_store.blob_hash` →
 *  keyless `blobs`. */
const makeEncryptedServer = async () => {
  const { mnemonic, entropy } = generateRecoveryKey();
  const recoveryHex = Buffer.from(entropy).toString('hex'); // what the CLI --key takes
  const { bundle, masterDEK } = await createServerBundle({
    recoveryKey: mnemonic,
    serverKey: generateServerKey(),
  });
  const blobKey = deriveSubDEK(masterDEK, 'blob-store');

  const dataDir = newDir('cli-enc-data-');
  const outDir = newDir('cli-enc-out-');
  const dbPath = join(dataDir, 'recued-server.db');

  // Encrypted CAS roots (cache + memory) + a keyless shared root.
  const cachePlaintext = randomBytes(80_000); // > 64 KB → multi-chunk stream
  const memoryPlaintext = randomBytes(70_000);
  const sharedPlaintext = randomBytes(3_000);
  const cacheHash = await createBlobStore(join(dataDir, 'cache_blobs'), { getEncryptionKey: () => blobKey }).put(cachePlaintext);
  const memoryHash = await createBlobStore(join(dataDir, 'memory_blobs'), { getEncryptionKey: () => blobKey }).put(memoryPlaintext);
  const sharedHash = await createBlobStore(join(dataDir, 'blobs')).put(sharedPlaintext);

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);
    CREATE TABLE user_memory (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE shared_store (key TEXT PRIMARY KEY, blob_hash TEXT);
  `);
  db.prepare(`INSERT INTO server_config (key, value) VALUES (?, ?)`)
    .run('server_vault_bundle', serverBundleToJSON(bundle));
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
    // No refuse anymore — the CLI derives the blob key from the db bundle.
    await cmdArchive(s.deps, ['export', dest, `--key=${s.recoveryHex}`]);
    expect(existsSync(dest)).toBe(true);

    // Restore into a fresh data dir. Restore re-derives the SAME blob key from
    // the archive's own db bundle (carried in the db backup) + the recovery key.
    const tgt = newDir('cli-enc-restore-');
    const res = await applyRestore(
      { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
      { archivePath: dest, recoveryKey: Buffer.from(s.recoveryHex, 'hex'), consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    );
    expect(res.blob_count).toBe(3);

    // Cache blob → cache_blobs, decrypts to the original, ciphertext at rest.
    const tgtCache = createBlobStore(join(tgt, 'cache_blobs'), { getEncryptionKey: () => s.blobKey });
    expect((await tgtCache.get(s.cacheHash))!.equals(s.cachePlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'cache_blobs'), s.cacheHash)).equals(s.cachePlaintext)).toBe(false);

    // Memory blob → its OWN memory_blobs root (not cache_blobs), same posture.
    const tgtMemory = createBlobStore(join(tgt, 'memory_blobs'), { getEncryptionKey: () => s.blobKey });
    expect((await tgtMemory.get(s.memoryHash))!.equals(s.memoryPlaintext)).toBe(true);
    expect(await tgtCache.has(s.memoryHash)).toBe(false);

    // Keyless shared blob → plaintext keyless root.
    const tgtShared = createBlobStore(join(tgt, 'blobs'));
    expect((await tgtShared.get(s.sharedHash))!.equals(s.sharedPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'blobs'), s.sharedHash)).equals(s.sharedPlaintext)).toBe(true);
  });

  it('refuses with an operator-facing message on a WRONG recovery key', async () => {
    const s = await makeEncryptedServer();
    // A DIFFERENT valid recovery key — unwrapping the Master DEK fails (GCM),
    // so the CLI refuses rather than archive undecryptable ciphertext.
    const wrongHex = Buffer.from(generateRecoveryKey().entropy).toString('hex');
    const dest = join(s.outDir, 'wrong.recued.archive');
    await expect(cmdArchive(s.deps, ['export', dest, `--key=${wrongHex}`]))
      .rejects.toThrow(/could not derive this server's blob encryption key/);
    // Nothing was written (it fails before exportArchive touches the dest).
    expect(existsSync(dest)).toBe(false);
  });

  it('--no-blobs skips key derivation → a database-only archive exports on ANY key', async () => {
    const s = await makeEncryptedServer();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A wrong key would fail the blob-key derivation, but --no-blobs never
    // derives it (the db-only escape hatch the refusal message points at).
    const wrongHex = Buffer.from(generateRecoveryKey().entropy).toString('hex');
    const dest = join(s.outDir, 'db-only.recued.archive');
    await cmdArchive(s.deps, ['export', dest, `--key=${wrongHex}`, '--no-blobs']);
    expect(existsSync(dest)).toBe(true);
  });
});

describe('archive export CLI — KEYLESS server (regression)', () => {
  it('still exports every root as plaintext and round-trips', async () => {
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
    await cmdArchive(deps, ['export', dest, `--key=${recoveryHex}`]);

    const tgt = newDir('cli-keyless-restore-');
    const res = await applyRestore(
      { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
      { archivePath: dest, recoveryKey: Buffer.from(recoveryHex, 'hex'), consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    );
    expect(res.blob_count).toBe(1);
    // Keyless realm → cache_blobs target is keyless → plaintext at rest.
    const tgtCache = createBlobStore(join(tgt, 'cache_blobs'));
    expect((await tgtCache.get(cacheHash))!.equals(cachePlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'cache_blobs'), cacheHash)).equals(cachePlaintext)).toBe(true);
  });
});

describe('deriveBlobStoreKeyFromDb — shared derivation (fail-closed)', () => {
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
      d.prepare(`INSERT INTO server_config VALUES (?, ?)`).run('server_vault_bundle', serverBundleToJSON(bundle));
    });
    try {
      const key = await deriveBlobStoreKeyFromDb(db, Buffer.from(entropy));
      // Byte-identical to what the live/post-restore server derives.
      expect(Buffer.from(key!).equals(Buffer.from(deriveSubDEK(masterDEK, 'blob-store')))).toBe(true);
    } finally { db.close(); }
  });

  it('returns null for a KEYLESS realm (server_config present, no bundle row)', async () => {
    const db = mkDb((d) => d.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`));
    try {
      expect(await deriveBlobStoreKeyFromDb(db, Buffer.from(generateRecoveryKey().entropy))).toBeNull();
    } finally { db.close(); }
  });

  it('returns null when server_config is entirely absent (older schema)', async () => {
    const db = mkDb((d) => d.exec(`CREATE TABLE something_else (k TEXT)`));
    try {
      expect(await deriveBlobStoreKeyFromDb(db, Buffer.from(generateRecoveryKey().entropy))).toBeNull();
    } finally { db.close(); }
  });

  it('FAILS CLOSED (throws) when server_config exists but is UNREADABLE — never a silent keyless', async () => {
    // A server_config table missing the `value` column makes the config SELECT
    // throw. The OLD `catch { return null }` turned that into a false "keyless"
    // → an encrypted realm would archive ciphertext. It must now PROPAGATE.
    const db = mkDb((d) => d.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY)`));
    try {
      await expect(deriveBlobStoreKeyFromDb(db, Buffer.from(generateRecoveryKey().entropy))).rejects.toThrow();
    } finally { db.close(); }
  });
});
