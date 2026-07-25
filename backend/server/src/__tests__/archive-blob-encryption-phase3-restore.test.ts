/* Archive blob-encryption fix — Phase 3 (restore). The capstone round-trip: an
 * ENCRYPTED server's blob survives a full export→restore. Phase 2 decrypts it
 * into the archive (plaintext); Phase 3 re-encrypts it on restore under the
 * RESTORED realm's key — read from the archive's own server-bundle sidecar
 * record + the recovery key — so the post-restore server can read it. Uses the
 * REAL exportArchive + applyRestore + blob-store, no mocks.
 * See internal design notes. */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  generateRecoveryKey,
  generateServerKey,
  createServerBundle,
  serverBundleToJSON,
  deriveSubDEK,
  recoveryKeyToEntropy,
} from '@recued/crypto';

import { createBlobStore, createEncryptedBlobStore } from '../storage/blob-store.js';
import { exportArchive } from '../archive/archive-export.js';
import { applyRestore, deriveRestoreBlobKey } from '../archive/archive-restore.js';
import {
  BLOB_NAME_PREFIX,
  CACHE_BLOB_NAME_PREFIX,
  MEMORY_BLOB_NAME_PREFIX,
} from '../archive/archive-format.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { deriveDatabaseKey } from '../database-encryption.js';
import { openDatabase } from '../open-database.js';

const FIXED_NOW = 1_700_000_000_000;
const dirs: string[] = [];
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'p3-restore-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});
const pathFor = (root: string, hash: string): string =>
  join(root, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

/** A source realm with a server vault bundle sidecar. Returns
 *  the recovery entropy (== the archive key), the derived blob-store sub-DEK,
 *  and the src dir. */
const makeEncryptedSource = async () => {
  const { mnemonic, entropy } = generateRecoveryKey();
  const recoveryEntropy = Buffer.from(entropy);
  const { bundle, masterDEK } = await createServerBundle({
    recoveryKey: mnemonic,
    serverKey: generateServerKey(),
  });
  const blobKey = deriveSubDEK(masterDEK, 'blob-store');
  const databaseKey = deriveDatabaseKey(masterDEK);
  masterDEK.fill(0);

  const srcDir = newDir();
  const srcDb = await openDatabase(join(srcDir, 'src.db'), { databaseKey });
  databaseKey.fill(0);
  srcDb.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return { recoveryEntropy, blobKey, bundle, srcDir, srcDb };
};

describe('Phase 3 restore — encrypted blob round-trip', () => {
  it('re-encrypts every blob root under the RESTORED realm key', async () => {
    const { recoveryEntropy, blobKey, bundle, srcDir, srcDb } = await makeEncryptedSource();

    // Every source CAS root is encrypted under the realm's blob sub-DEK.
    const srcCache = createEncryptedBlobStore(join(srcDir, 'cache_blobs'), () => blobKey);
    const cachePlaintext = randomBytes(80_000); // > 64 KB, multi-chunk
    const cacheHash = await srcCache.put(cachePlaintext);
    // An encrypted MEMORY blob (its own root, same realm key).
    const srcMemory = createEncryptedBlobStore(join(srcDir, 'memory_blobs'), () => blobKey);
    const memoryPlaintext = randomBytes(70_000);
    const memoryHash = await srcMemory.put(memoryPlaintext);
    const srcShared = createEncryptedBlobStore(join(srcDir, 'blobs'), () => blobKey);
    const sharedPlaintext = randomBytes(3000);
    const sharedHash = await srcShared.put(sharedPlaintext);
    // Both the cache and shared blobs really are ciphertext at rest.
    expect(readFileSync(pathFor(join(srcDir, 'cache_blobs'), cacheHash)).equals(cachePlaintext)).toBe(false);
    expect(readFileSync(pathFor(join(srcDir, 'blobs'), sharedHash)).equals(sharedPlaintext)).toBe(false);

    // Export (Phase 2 decrypts the encrypted sources into the archive).
    const archivePath = join(srcDir, 'out.recued.archive');
    await exportArchive({
      destPath: archivePath,
      recoveryKey: recoveryEntropy,
      db: srcDb,
      serverVaultBundleJson: serverBundleToJSON(bundle),
      blobSources: [
        { store: srcShared, hashes: [sharedHash], prefix: BLOB_NAME_PREFIX },
        { store: srcCache, hashes: [cacheHash], prefix: CACHE_BLOB_NAME_PREFIX },
        { store: srcMemory, hashes: [memoryHash], prefix: MEMORY_BLOB_NAME_PREFIX },
      ],
      producerVersion: '0.2.0',
    });
    srcDb.close();

    // Restore into a fresh data dir.
    const tgt = newDir();
    const tgtDbPath = join(tgt, 'recued-server.db');
    const res = await applyRestore(
      { dbPath: tgtDbPath, dataPath: tgt, configPath: null },
      { archivePath, recoveryKey: recoveryEntropy, consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    );
    expect(res.blob_count).toBe(3);
    const restoredBundle = createServerBundleStore(tgtDbPath).load();
    expect(restoredBundle).not.toBeNull();
    expect(restoredBundle?.wrapped_rec).toBe(bundle.wrapped_rec);
    expect(restoredBundle?.salt_rec).toBe(bundle.salt_rec);
    expect(restoredBundle?.wrapped_server).not.toBe(bundle.wrapped_server);
    const rebooted = await openDatabase(tgtDbPath, {
      readonly: true,
      fileMustExist: true,
      keyEnvironment: {},
    });
    rebooted.close();

    // The cache blob landed in cache_blobs (NOT blobs) and decrypts — under the
    // key restore re-derived from the archive's server bundle — to the original.
    const tgtCache = createEncryptedBlobStore(join(tgt, 'cache_blobs'), () => blobKey);
    expect(await tgtCache.has(cacheHash)).toBe(true);
    expect((await tgtCache.get(cacheHash))!.equals(cachePlaintext)).toBe(true);
    // …and is genuinely RE-ENCRYPTED at rest (ciphertext, not the plaintext).
    expect(readFileSync(pathFor(join(tgt, 'cache_blobs'), cacheHash)).equals(cachePlaintext)).toBe(false);

    // The memory blob lands in memory_blobs (its OWN root) and re-encrypts the same way.
    const tgtMemory = createEncryptedBlobStore(join(tgt, 'memory_blobs'), () => blobKey);
    expect((await tgtMemory.get(memoryHash))!.equals(memoryPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'memory_blobs'), memoryHash)).equals(memoryPlaintext)).toBe(false);
    expect(await tgtCache.has(memoryHash)).toBe(false); // routed to memory_blobs, not cache_blobs

    // The historical shared root is now encrypted too.
    const tgtShared = createEncryptedBlobStore(join(tgt, 'blobs'), () => blobKey);
    expect((await tgtShared.get(sharedHash))!.equals(sharedPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'blobs'), sharedHash)).equals(sharedPlaintext)).toBe(false);
  });

  it('refuses a legacy keyless-realm archive with blobs instead of restoring plaintext', async () => {
    // The low-level archive fixture still permits a keyless source so old wire
    // input can be exercised. Production restore must fail closed because no
    // server-vault bundle means there is no at-rest blob key.
    const recoveryEntropy = Buffer.from(generateRecoveryKey().entropy);
    const srcDir = newDir();
    const srcDb = new Database(join(srcDir, 'src.db'));
    srcDb.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const srcCache = createBlobStore(join(srcDir, 'cache_blobs'));
    const plaintext = randomBytes(5000);
    const hash = await srcCache.put(plaintext);

    const archivePath = join(srcDir, 'keyless.recued.archive');
    await exportArchive({
      destPath: archivePath,
      recoveryKey: recoveryEntropy,
      db: srcDb,
      blobSources: [{ store: srcCache, hashes: [hash], prefix: CACHE_BLOB_NAME_PREFIX }],
      producerVersion: '0.2.0',
    });
    srcDb.close();

    const tgt = newDir();
    const tgtDbPath = join(tgt, 'recued-server.db');
    await expect(applyRestore(
      { dbPath: tgtDbPath, dataPath: tgt, configPath: null },
      { archivePath, recoveryKey: recoveryEntropy, consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    )).rejects.toThrow(/D212_BLOB_KEY_REQUIRED/);
    expect(existsSync(tgtDbPath)).toBe(false);
    expect(existsSync(pathFor(join(tgt, 'cache_blobs'), hash))).toBe(false);
  });
});

describe('deriveRestoreBlobKey (the restore re-encryption key)', () => {
  const mkDb = async (
    write?: (db: Database.Database) => void,
    databaseKey: Uint8Array | null = null,
  ): Promise<string> => {
    const p = join(newDir(), 'staged.db');
    const db = await openDatabase(p, { databaseKey });
    if (write) write(db);
    db.close();
    return p;
  };

  it('derives the blob-store sub-DEK from the server bundle + recovery entropy', async () => {
    const { mnemonic } = generateRecoveryKey();
    const { bundle, masterDEK } = await createServerBundle({
      recoveryKey: mnemonic,
      serverKey: generateServerKey(),
    });
    const databaseKey = deriveDatabaseKey(masterDEK);
    const dbPath = await mkDb((db) => {
      db.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    }, databaseKey);
    databaseKey.fill(0);
    const key = await deriveRestoreBlobKey(
      dbPath,
      bundle,
      recoveryKeyToEntropy(mnemonic),
    );
    expect(key).not.toBeNull();
    // …and it is EXACTLY the key the post-restore server derives.
    expect(Buffer.from(key!).equals(Buffer.from(deriveSubDEK(masterDEK, 'blob-store')))).toBe(true);
  });

  it('returns null for a KEYLESS realm (db has tables but no bundle)', async () => {
    const dbPath = await mkDb((db) => db.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`));
    expect(await deriveRestoreBlobKey(
      dbPath,
      null,
      recoveryKeyToEntropy(generateRecoveryKey().mnemonic),
    )).toBeNull();
  });

  it('FAILS CLOSED on an EMPTY staged db (a blob record before the db → no silent plaintext)', async () => {
    const dbPath = await mkDb(); // 0 tables — stands in for the db-not-yet-written case
    await expect(
      deriveRestoreBlobKey(
        dbPath,
        null,
        recoveryKeyToEntropy(generateRecoveryKey().mnemonic),
      ),
    ).rejects.toThrow(/ARCHIVE_INVALID/);
  });

  it('throws (GCM) on the wrong recovery entropy', async () => {
    const { mnemonic } = generateRecoveryKey();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey: mnemonic, serverKey: generateServerKey() });
    const databaseKey = deriveDatabaseKey(masterDEK);
    masterDEK.fill(0);
    const dbPath = await mkDb((db) => {
      db.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    }, databaseKey);
    databaseKey.fill(0);
    await expect(
      deriveRestoreBlobKey(
        dbPath,
        bundle,
        recoveryKeyToEntropy(generateRecoveryKey().mnemonic),
      ),
    ).rejects.toThrow();
  });
});
