/** D-212 — the restore blob key must be RETRACTED, not merely zeroed.
 *
 *  `streamRestoreInto` derives the restored realm's blob sub-DEK once, parks it
 *  on a ref, and hands every CAS target store a `getBlobKey` closure over that
 *  ref. When the restore ends it wipes the buffer. Wiping alone leaves the
 *  closure answering with 32 zero bytes — a real, usable, publicly-known key —
 *  so a store built during the restore would keep encrypting instead of
 *  refusing. The provider indirection exists to fail CLOSED, and only a null
 *  reaches `requireKey`'s locked throw.
 *
 *  The three stores are function-local today and never escape, which makes this
 *  latent rather than live. It is pinned here because the closure is the thing
 *  that would escape first, and nothing about the containment is enforced.
 *
 *  `../storage/blob-store.js` is mocked as a pass-through solely to CAPTURE the
 *  key provider restore hands each store — the store itself is the real one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createServerBundle,
  deriveSubDEK,
  generateRecoveryKey,
  generateServerKey,
  serverBundleToJSON,
} from '@recued/crypto';

const captured = vi.hoisted(() => ({ providers: [] as Array<() => Uint8Array | null> }));

vi.mock('../storage/blob-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/blob-store.js')>();
  return {
    ...actual,
    createEncryptedBlobStore: (root: string, getEncryptionKey: () => Uint8Array | null) => {
      captured.providers.push(getEncryptionKey);
      return actual.createEncryptedBlobStore(root, getEncryptionKey);
    },
  };
});

// Imported AFTER vi.mock so both the SUT and this file bind the wrapped factory.
const { createEncryptedBlobStore } = await import('../storage/blob-store.js');
const { exportArchive } = await import('../archive/archive-export.js');
const { applyRestore } = await import('../archive/archive-restore.js');
const { CACHE_BLOB_NAME_PREFIX } = await import('../archive/archive-format.js');
const { deriveDatabaseKey } = await import('../database-encryption.js');
const { openDatabase } = await import('../open-database.js');

const FIXED_NOW = 1_700_000_000_000;
const dirs: string[] = [];
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'restore-key-wipe-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  captured.providers.length = 0;
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

describe('streamRestoreInto — the derived blob key after the restore ends', () => {
  it('leaves every store it built holding a NULL provider, not a zeroed key', async () => {
    // A source realm with a server vault bundle, so the restore has a sidecar to
    // re-derive the blob sub-DEK from and really does build the keyed targets.
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
    const srcCache = createEncryptedBlobStore(join(srcDir, 'cache_blobs'), () => blobKey);
    const plaintext = randomBytes(4096);
    const cacheHash = await srcCache.put(Buffer.from(plaintext));

    const archivePath = join(srcDir, 'out.recued.archive');
    await exportArchive({
      destPath: archivePath,
      recoveryKey: recoveryEntropy,
      db: srcDb,
      serverVaultBundleJson: serverBundleToJSON(bundle),
      blobSources: [{ store: srcCache, hashes: [cacheHash], prefix: CACHE_BLOB_NAME_PREFIX }],
      producerVersion: '0.2.0',
    });
    srcDb.close();

    // Only the providers restore itself hands out are under test.
    captured.providers.length = 0;

    const tgt = newDir();
    const res = await applyRestore(
      { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
      { archivePath, recoveryKey: recoveryEntropy, consumerVersion: '0.2.0' },
      { now: () => FIXED_NOW },
    );
    expect(res.blob_count).toBe(1);
    // One memoized derivation builds all three roots, so all three closures
    // read the same ref — proving the capture caught the real thing.
    const providers = [...captured.providers];
    expect(providers).toHaveLength(3);

    for (const provider of providers) {
      expect(provider()).toBeNull();
    }

    // The consequence the null exists for: a store still holding this provider
    // refuses to write. A zeroed-but-present key would encrypt happily under 32
    // known bytes and report success.
    const store = createEncryptedBlobStore(join(tgt, 'cache_blobs'), providers[0]!);
    await expect(store.put(Buffer.from('a write after the restore ended'))).rejects.toThrow(
      /blob-store: locked/,
    );
  });
});
