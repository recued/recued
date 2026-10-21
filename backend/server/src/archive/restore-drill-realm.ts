/** Reuse the offline recovery path, with EVERY target in the caller's private
 * directory. Never boot the realm, dial providers, or run restored work. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchiveRestoreDrillChecks } from '@recued/contracts';
import { openDatabase } from '../open-database.js';
import { resolveDatabaseKeyFromServerFiles } from '../database-encryption.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { buildExportBlobSources } from './archive-export.js';
import { applyRestore, deriveBlobStoreKey } from './archive-restore.js';

export const restoreDrillRealm = async (options: {
  archivePath: string; dataPath: string; entropy: Buffer; serverVersion: string; onChecking(): void | Promise<void>;
}): Promise<ArchiveRestoreDrillChecks> => {
  const dbPath = join(options.dataPath, 'realm.db');
  const restored = await applyRestore({ dbPath, dataPath: options.dataPath, configPath: join(options.dataPath, 'config.json') }, {
    archivePath: options.archivePath, recoveryKey: options.entropy, consumerVersion: options.serverVersion,
  });
  await options.onChecking();
  // Read through the destination's newly written boot keyfile, rather than
  // only reopening with the recovery factor already held by this operation.
  const bundle = createServerBundleStore(dbPath).load();
  if (!bundle) throw new Error('An encrypted server vault is required for this drill');
  const databaseKey = await resolveDatabaseKeyFromServerFiles(dbPath);
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  let blobKey: Uint8Array | null = null;
  try {
    db = await openDatabase(dbPath, { readonly: true, fileMustExist: true, databaseKey });
    db.pragma('query_only = ON');
    const integrity = db.prepare<[], { integrity_check: string }>('PRAGMA integrity_check').iterate();
    let rows = 0;
    for (const row of integrity) {
      rows++;
      if (Object.values(row).length !== 1 || Object.values(row)[0] !== 'ok') throw new Error('Database integrity check failed');
    }
    if (rows !== 1) throw new Error('Database integrity check failed');
    // Iterate only the first violation; do not retain user rows or raw errors.
    for (const _row of db.prepare('PRAGMA foreign_key_check').iterate()) throw new Error('Database foreign key check failed');
    blobKey = await deriveBlobStoreKey({ db, serverBundle: bundle, recoveryEntropy: options.entropy });
    if (!blobKey) throw new Error('Blob key is unavailable');
    let referenced_blobs = 0, blob_bytes = 0;
    const plain = join(options.dataPath, 'checked-blob.tmp');
    for (const source of buildExportBlobSources(options.dataPath, db, () => blobKey)) {
      // Production encrypted stores verify AEAD before the file can be read.
      for (const hash of source.hashes) {
        if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error('Invalid blob reference');
        try {
          await source.store.decryptToFile!(hash, plain);
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(plain)) { digest.update(chunk); blob_bytes += chunk.length; }
          if (digest.digest('hex') !== hash) throw new Error('Restored blob hash mismatch');
          referenced_blobs++;
        } finally { await unlink(plain).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      }
    }
    return { version: 1, server_version: options.serverVersion, database_integrity: 'ok', foreign_keys: 'ok', local_boot_key: 'ok',
      database_bytes: restored.db_bytes, restored_blob_records: restored.blob_count, referenced_blobs, blob_bytes };
  } finally {
    try { db?.close(); } finally { databaseKey?.fill(0); blobKey?.fill(0); }
  }
};
