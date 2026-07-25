/* Archive blob-encryption fix — Phase 2 (export). Proves the export carries
 * PLAINTEXT for every posture: a keyless source streams its on-disk bytes; an
 * ENCRYPTED source is decrypted (tag-verified) before it enters the archive, so
 * restore (Phase 3) can re-encrypt under the restoring server's key. Verified by
 * decoding the archive records directly (the importer refuses the new
 * cache-blobs/ namespace until Phase 3, so a full round-trip lands there). See
 * docs/archive-blob-encryption-fix.md. */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createBlobStore } from '../storage/blob-store.js';
import {
  exportArchive,
  collectBlobHashesByStore,
  buildExportBlobSources,
} from '../archive/archive-export.js';
import { summarizeArchive } from '../archive/archive-import.js';
import { deriveArchiveKeys, decryptRecord } from '../archive/archive-crypto.js';
import {
  BLOB_NAME_PREFIX,
  CACHE_BLOB_NAME_PREFIX,
  MAGIC_LEN,
  UINT32_LEN,
  HMAC_LEN,
} from '../archive/archive-format.js';

const dirs: string[] = [];
const mkdir = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

/** Walk an archive → { record name → decrypted plaintext body }. Mirrors the
 *  format (`MAGIC | u32 manifestLen | manifest | records | HMAC`) but decrypts
 *  each body directly, bypassing the importer's Phase-2 refusal of the new
 *  namespaces — so we can assert what the export actually stored. */
const readArchiveRecords = (archivePath: string, recoveryKey: Buffer): Map<string, Buffer> => {
  const buf = readFileSync(archivePath);
  let off = MAGIC_LEN;
  const manifestLen = buf.readUInt32BE(off); off += UINT32_LEN;
  const manifest = JSON.parse(buf.subarray(off, off + manifestLen).toString('utf8'));
  off += manifestLen;
  const keys = deriveArchiveKeys(recoveryKey, Buffer.from(manifest.encryption.salt_hex, 'hex'));
  const end = buf.length - HMAC_LEN;
  const records = new Map<string, Buffer>();
  while (off < end) {
    const nameLen = buf.readUInt32BE(off); off += UINT32_LEN;
    const name = buf.subarray(off, off + nameLen).toString('utf8'); off += nameLen;
    const bodyLen = buf.readUInt32BE(off); off += UINT32_LEN;
    const body = buf.subarray(off, off + bodyLen); off += bodyLen;
    records.set(name, decryptRecord(keys.content, Buffer.from(body)));
  }
  return records;
};

const newDb = (): Database.Database => new Database(join(mkdir('p2-db-'), 'w.db'));

describe('Phase 2 export — plaintext across postures', () => {
  it('an ENCRYPTED source is DECRYPTED into the archive; a keyless source passes through', async () => {
    const dir = mkdir('p2-cas-');
    const key = randomBytes(32);
    const encStore = createBlobStore(join(dir, 'cache_blobs'), { getEncryptionKey: () => key });
    const keylessStore = createBlobStore(join(dir, 'blobs'));
    const pCache = randomBytes(9000);   // multi-chunk
    const pShared = randomBytes(3000);
    const hCache = await encStore.put(pCache);
    const hShared = await keylessStore.put(pShared);

    const recoveryKey = randomBytes(32);
    const destPath = join(dir, 'out.recued.archive');
    const res = await exportArchive({
      destPath,
      recoveryKey,
      db: newDb(),
      blobSources: [
        { store: keylessStore, hashes: [hShared], prefix: BLOB_NAME_PREFIX },
        { store: encStore, hashes: [hCache], prefix: CACHE_BLOB_NAME_PREFIX },
      ],
      force: true,
      producerVersion: '9.9.9',
    });

    expect(res.blob_count).toBe(2);
    // blob_bytes is the PLAINTEXT total (not the encrypted on-disk size).
    expect(res.manifest.blob_bytes).toBe(9000 + 3000);
    expect(res.manifest.archive_format_version).toBe(2);

    const records = readArchiveRecords(destPath, recoveryKey);
    // The encrypted source's blob is stored as PLAINTEXT under cache-blobs/.
    expect(records.get(`${CACHE_BLOB_NAME_PREFIX}${hCache}`)!.equals(pCache)).toBe(true);
    // And it really WAS ciphertext at rest (so the export decrypted it).
    expect(records.get(`${CACHE_BLOB_NAME_PREFIX}${hCache}`)!.equals(pShared)).toBe(false);
    // The keyless source passes through unchanged under blobs/.
    expect(records.get(`${BLOB_NAME_PREFIX}${hShared}`)!.equals(pShared)).toBe(true);
  });

  it('back-compat: the legacy `blobs` + `blobHashes` still produce blobs/ records', async () => {
    const dir = mkdir('p2-compat-');
    const keyless = createBlobStore(join(dir, 'blobs'));
    const p = randomBytes(2000);
    const h = await keyless.put(p);
    const recoveryKey = randomBytes(32);
    const destPath = join(dir, 'legacy.recued.archive');

    const res = await exportArchive({
      destPath,
      recoveryKey,
      db: newDb(),
      blobs: keyless,
      blobHashes: [h],
      force: true,
      producerVersion: '9.9.9',
    });
    expect(res.blob_count).toBe(1);
    expect(readArchiveRecords(destPath, recoveryKey).get(`${BLOB_NAME_PREFIX}${h}`)!.equals(p)).toBe(true);
  });

  it('the importer now ACCEPTS the cache-blobs/ namespace (Phase 3 routing replaced the interim guard)', async () => {
    const dir = mkdir('p2-refuse-');
    const key = randomBytes(32);
    const encStore = createBlobStore(join(dir, 'cache_blobs'), { getEncryptionKey: () => key });
    const hCache = await encStore.put(randomBytes(1500));
    const recoveryKey = randomBytes(32);
    const destPath = join(dir, 'v2.recued.archive');
    await exportArchive({
      destPath,
      recoveryKey,
      db: newDb(),
      blobSources: [{ store: encStore, hashes: [hCache], prefix: CACHE_BLOB_NAME_PREFIX }],
      force: true,
      producerVersion: '9.9.9',
    });

    // Phase 3 replaced the interim startBody throw with per-namespace routing,
    // so summarize now decodes the whole v2 archive (incl. the cache-blobs/
    // record) instead of refusing it.
    const summary = await summarizeArchive({ archivePath: destPath, recoveryKey, consumerVersion: '9.9.9' });
    expect(summary.blobCount).toBe(1);
  });
});

describe('collectBlobHashesByStore', () => {
  it('splits refs by CAS root: keyless=shared∪annotation, cache=cache∪collection, memory=user_memory', () => {
    const db = newDb();
    db.exec(`
      CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);
      CREATE TABLE shared_store (key TEXT PRIMARY KEY, blob_hash TEXT);
      CREATE TABLE annotation (id TEXT PRIMARY KEY, blob_hash TEXT);
      CREATE TABLE collection_mail_work (record_id TEXT PRIMARY KEY, blob_hash TEXT);
      CREATE TABLE user_memory (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    db.exec(`
      INSERT INTO cache_entries VALUES ('a','cache-1'),('b',NULL);
      INSERT INTO shared_store VALUES ('c','shared-1');
      INSERT INTO annotation VALUES ('an1','anno-1'),('an2',NULL);
      INSERT INTO collection_mail_work VALUES ('d','coll-1'),('e','cache-1');
    `);
    // user_memory rows are (key, JSON data); blob_hash lives inside data.
    db.prepare(`INSERT INTO user_memory VALUES (?, ?)`).run('umem_1', JSON.stringify({ memory_id: 'umem_1', blob_hash: 'mem-1' }));
    db.prepare(`INSERT INTO user_memory VALUES (?, ?)`).run('umem_2', JSON.stringify({ memory_id: 'umem_2', body_inline: 'inline, no blob' }));

    const by = collectBlobHashesByStore(db);
    // keyless = shared ∪ annotation.
    expect(new Set(by.keyless)).toEqual(new Set(['shared-1', 'anno-1']));
    // cache ∪ collection, de-duped across the two.
    expect(new Set(by.cache)).toEqual(new Set(['cache-1', 'coll-1']));
    // memory = user_memory blob refs (json_extract), skipping inline-body rows.
    expect(new Set(by.memory)).toEqual(new Set(['mem-1']));
  });

  it('tolerates missing tables (all groups empty)', () => {
    const db = newDb();
    const by = collectBlobHashesByStore(db);
    expect(by).toEqual({ keyless: [], cache: [], memory: [] });
  });
});

describe('buildExportBlobSources (keyless server)', () => {
  it('builds keyless posture-tagged sources with no KeyManager', async () => {
    const dir = mkdir('p2-sources-');
    const db = new Database(join(dir, 'w.db'));
    db.exec(`
      CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);
      CREATE TABLE shared_store (key TEXT PRIMARY KEY, blob_hash TEXT);
    `);
    db.exec(`INSERT INTO cache_entries VALUES ('a','h-cache'); INSERT INTO shared_store VALUES ('b','h-shared');`);
    const sources = buildExportBlobSources(dir, db, undefined);
    const byPrefix = new Map(sources.map((s) => [s.prefix, s]));
    expect(byPrefix.get(BLOB_NAME_PREFIX)!.hashes).toEqual(['h-shared']);
    expect(byPrefix.get(BLOB_NAME_PREFIX)!.store.encrypted).toBe(false);
    expect(byPrefix.get(CACHE_BLOB_NAME_PREFIX)!.hashes).toEqual(['h-cache']);
    // Keyless server → the cache root is plaintext too (no key given).
    expect(byPrefix.get(CACHE_BLOB_NAME_PREFIX)!.store.encrypted).toBe(false);
  });
});
