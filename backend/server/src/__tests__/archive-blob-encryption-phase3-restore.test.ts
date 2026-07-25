/* Archive blob-encryption fix — Phase 3 (restore). The capstone round-trip: an
 * ENCRYPTED server's blob survives a full export→restore. Phase 2 decrypts it
 * into the archive (plaintext); Phase 3 re-encrypts it on restore under the
 * RESTORED realm's key — read from the archive's own server bundle (carried in
 * its db) + the recovery key — so the post-restore server can read it. Uses the
 * REAL exportArchive + applyRestore + blob-store, no mocks.
 * See docs/archive-blob-encryption-fix.md. */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

import { createBlobStore } from '../storage/blob-store.js';
import { exportArchive } from '../archive/archive-export.js';
import { applyRestore, deriveRestoreBlobKey } from '../archive/archive-restore.js';
import {
  BLOB_NAME_PREFIX,
  CACHE_BLOB_NAME_PREFIX,
  MEMORY_BLOB_NAME_PREFIX,
} from '../archive/archive-format.js';

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

/** A source db seeded with a server vault bundle (an encrypted realm). Returns
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

  const srcDir = newDir();
  const srcDb = new Database(join(srcDir, 'src.db'));
  srcDb.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  srcDb.prepare(`INSERT INTO server_config (key, value) VALUES (?, ?)`)
    .run('server_vault_bundle', serverBundleToJSON(bundle));
  return { recoveryEntropy, blobKey, srcDir, srcDb };
};

describe('Phase 3 restore — encrypted blob round-trip', () => {
  it('re-encrypts a cache blob under the RESTORED realm key; keyless blob passes through', async () => {
    const { recoveryEntropy, blobKey, srcDir, srcDb } = await makeEncryptedSource();

    // An ENCRYPTED cache blob + a KEYLESS shared blob in the source's roots.
    const srcCache = createBlobStore(join(srcDir, 'cache_blobs'), { getEncryptionKey: () => blobKey });
    const cachePlaintext = randomBytes(80_000); // > 64 KB, multi-chunk
    const cacheHash = await srcCache.put(cachePlaintext);
    // An encrypted MEMORY blob (its own root, same realm key).
    const srcMemory = createBlobStore(join(srcDir, 'memory_blobs'), { getEncryptionKey: () => blobKey });
    const memoryPlaintext = randomBytes(70_000);
    const memoryHash = await srcMemory.put(memoryPlaintext);
    const srcShared = createBlobStore(join(srcDir, 'blobs'));
    const sharedPlaintext = randomBytes(3000);
    const sharedHash = await srcShared.put(sharedPlaintext);
    // The cache blob really is ciphertext at rest in the source.
    expect(readFileSync(pathFor(join(srcDir, 'cache_blobs'), cacheHash)).equals(cachePlaintext)).toBe(false);

    // Export (Phase 2 decrypts the encrypted sources into the archive).
    const archivePath = join(srcDir, 'out.recued.archive');
    await exportArchive({
      destPath: archivePath,
      recoveryKey: recoveryEntropy,
      db: srcDb,
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
    const res = await applyRestore(
      { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
      { archivePath, recoveryKey: recoveryEntropy, consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    );
    expect(res.blob_count).toBe(3);

    // The cache blob landed in cache_blobs (NOT blobs) and decrypts — under the
    // key restore re-derived from the archive's server bundle — to the original.
    const tgtCache = createBlobStore(join(tgt, 'cache_blobs'), { getEncryptionKey: () => blobKey });
    expect(await tgtCache.has(cacheHash)).toBe(true);
    expect((await tgtCache.get(cacheHash))!.equals(cachePlaintext)).toBe(true);
    // …and is genuinely RE-ENCRYPTED at rest (ciphertext, not the plaintext).
    expect(readFileSync(pathFor(join(tgt, 'cache_blobs'), cacheHash)).equals(cachePlaintext)).toBe(false);

    // The memory blob lands in memory_blobs (its OWN root) and re-encrypts the same way.
    const tgtMemory = createBlobStore(join(tgt, 'memory_blobs'), { getEncryptionKey: () => blobKey });
    expect((await tgtMemory.get(memoryHash))!.equals(memoryPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'memory_blobs'), memoryHash)).equals(memoryPlaintext)).toBe(false);
    expect(await tgtCache.has(memoryHash)).toBe(false); // routed to memory_blobs, not cache_blobs

    // The keyless shared blob round-trips as plaintext in the keyless root.
    const tgtShared = createBlobStore(join(tgt, 'blobs'));
    expect((await tgtShared.get(sharedHash))!.equals(sharedPlaintext)).toBe(true);
  });

  it('a KEYLESS-realm archive restores its cache blob as plaintext (no bundle → keyless target)', async () => {
    // No server_vault_bundle row → keyless realm → the source cache_blobs root
    // is plaintext, and restore builds a keyless cache_blobs target. One
    // recovery key throughout (it still encrypts the ARCHIVE's records).
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
    const res = await applyRestore(
      { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
      { archivePath, recoveryKey: recoveryEntropy, consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    );
    expect(res.blob_count).toBe(1);
    // Keyless realm → cache_blobs target is keyless → plaintext at rest.
    const tgtCache = createBlobStore(join(tgt, 'cache_blobs'));
    expect((await tgtCache.get(hash))!.equals(plaintext)).toBe(true);
    expect(readFileSync(pathFor(join(tgt, 'cache_blobs'), hash)).equals(plaintext)).toBe(true);
  });
});

describe('deriveRestoreBlobKey (the restore re-encryption key)', () => {
  const mkDb = (write?: (db: Database.Database) => void): string => {
    const p = join(newDir(), 'staged.db');
    const db = new Database(p);
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
    const dbPath = mkDb((db) => {
      db.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.prepare(`INSERT INTO server_config VALUES (?, ?)`).run('server_vault_bundle', serverBundleToJSON(bundle));
    });
    const key = await deriveRestoreBlobKey(dbPath, recoveryKeyToEntropy(mnemonic));
    expect(key).not.toBeNull();
    // …and it is EXACTLY the key the post-restore server derives.
    expect(Buffer.from(key!).equals(Buffer.from(deriveSubDEK(masterDEK, 'blob-store')))).toBe(true);
  });

  it('returns null for a KEYLESS realm (db has tables but no bundle)', async () => {
    const dbPath = mkDb((db) => db.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`));
    expect(await deriveRestoreBlobKey(dbPath, recoveryKeyToEntropy(generateRecoveryKey().mnemonic))).toBeNull();
  });

  it('FAILS CLOSED on an EMPTY staged db (a blob record before the db → no silent plaintext)', async () => {
    const dbPath = mkDb(); // 0 tables — stands in for the db-not-yet-written case
    await expect(
      deriveRestoreBlobKey(dbPath, recoveryKeyToEntropy(generateRecoveryKey().mnemonic)),
    ).rejects.toThrow(/ARCHIVE_INVALID/);
  });

  it('throws (GCM) on the wrong recovery entropy', async () => {
    const { mnemonic } = generateRecoveryKey();
    const { bundle } = await createServerBundle({ recoveryKey: mnemonic, serverKey: generateServerKey() });
    const dbPath = mkDb((db) => {
      db.exec(`CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.prepare(`INSERT INTO server_config VALUES (?, ?)`).run('server_vault_bundle', serverBundleToJSON(bundle));
    });
    await expect(
      deriveRestoreBlobKey(dbPath, recoveryKeyToEntropy(generateRecoveryKey().mnemonic)),
    ).rejects.toThrow();
  });
});
