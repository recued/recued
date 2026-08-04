/** M2 — archive export streaming rework.
 *
 *  Covers the behaviours the streamed assembler must hold that the prior
 *  RAM-buffered (`Buffer.concat` → `writeFileSync`) shape got for free:
 *    - `createRecordCipher` emits the exact `iv || ct || tag` framing
 *      `decryptRecord` consumes, across multiple `update` chunks + empty.
 *    - a db that spans several read-stream chunks round-trips byte-exact
 *      (the streamed GCM cipher must not corrupt across chunk boundaries).
 *    - `uint32BE` REFUSES an over-u32 record length instead of silently
 *      wrapping (the old `n >>> 0`) — a streamed >4 GiB db would otherwise
 *      write a "successful" but unreadable archive.
 *    - the temp db copy + `.partial` archive are reclaimed on every
 *      failure path after the backup (no GB-sized residue for a no-SSH
 *      user), and on the success path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { exportArchive, uint32BE } from '../archive/archive-export.js';
import { importArchive, summarizeArchive } from '../archive/archive-import.js';
import {
  createRecordCipher,
  createRecordDecipher,
  decryptRecord,
} from '../archive/archive-crypto.js';
import { AEAD_TAG_LEN, IV_LEN } from '../archive/archive-format.js';
import { applyRestore } from '../archive/archive-restore.js';
import { EXPORT_DB_SCRATCH_PREFIX } from '../archive/archive-scratch.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';

const mkKey = (byte: number): Buffer => Buffer.alloc(32, byte);

interface Harness {
  dir: string;
  db: Database.Database;
  close(): void;
}

const newHarness = (rows = 1): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-stream-'));
  const db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
  const insert = db.prepare('INSERT INTO example VALUES (?, ?)');
  const many = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) insert.run(`k${i}`, `v${i}-${'x'.repeat(200)}`);
  });
  many(rows);
  return {
    dir, db,
    close() {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(() => { h?.close(); });

// ────────────────────────────────────────────────────────────────
// createRecordCipher — the streaming counterpart to encryptRecord
// ────────────────────────────────────────────────────────────────

describe('createRecordCipher', () => {
  const key = mkKey(33);

  const frame = (cipher: ReturnType<typeof createRecordCipher>, chunks: Buffer[]): Buffer => {
    const parts = [cipher.iv];
    for (const c of chunks) {
      const ct = cipher.update(c);
      if (ct.length > 0) parts.push(ct);
    }
    parts.push(cipher.final());
    return Buffer.concat(parts);
  };

  it('single-chunk frame decrypts back to the plaintext', () => {
    const plain = Buffer.from('the quick brown fox', 'utf8');
    const body = frame(createRecordCipher(key), [plain]);
    expect(body.length).toBe(IV_LEN + plain.length + AEAD_TAG_LEN);
    expect(decryptRecord(key, body).equals(plain)).toBe(true);
  });

  it('multi-chunk frame decrypts back identically to a one-shot encrypt', () => {
    const plain = Buffer.from('x'.repeat(10_000), 'utf8');
    const thirds = [plain.subarray(0, 3000), plain.subarray(3000, 7000), plain.subarray(7000)];
    const body = frame(createRecordCipher(key), thirds);
    expect(body.length).toBe(IV_LEN + plain.length + AEAD_TAG_LEN);
    expect(decryptRecord(key, body).equals(plain)).toBe(true);
  });

  it('empty plaintext frames to iv + tag only', () => {
    const body = frame(createRecordCipher(key), []);
    expect(body.length).toBe(IV_LEN + AEAD_TAG_LEN);
    expect(decryptRecord(key, body).length).toBe(0);
  });

  it('a tampered body fails the GCM tag', () => {
    const body = frame(createRecordCipher(key), [Buffer.from('secret', 'utf8')]);
    body[body.length - 1] ^= 0x01; // corrupt the auth tag
    expect(() => decryptRecord(key, body)).toThrow();
  });

  it('the wrong key fails the GCM tag', () => {
    const body = frame(createRecordCipher(key), [Buffer.from('secret', 'utf8')]);
    expect(() => decryptRecord(mkKey(99), body)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// uint32BE — refuse over-u32 record lengths (no silent wrap)
// ────────────────────────────────────────────────────────────────

describe('uint32BE record-length guard', () => {
  it('encodes in-range values, including the u32 boundary', () => {
    expect([...uint32BE(0)]).toEqual([0, 0, 0, 0]);
    expect([...uint32BE(1)]).toEqual([0, 0, 0, 1]);
    expect([...uint32BE(0xffffffff)]).toEqual([255, 255, 255, 255]);
  });

  it('refuses a length past the u32 ceiling instead of wrapping', () => {
    // The old `n >>> 0` would have silently produced [0,0,0,0] here.
    expect(() => uint32BE(0x1_0000_0000)).toThrow(/ARCHIVE_RECORD_TOO_LARGE/);
    expect(() => uint32BE(0x1_0000_0001)).toThrow(/ARCHIVE_RECORD_TOO_LARGE/);
  });

  it('refuses negative + non-integer lengths', () => {
    expect(() => uint32BE(-1)).toThrow(/ARCHIVE_RECORD_TOO_LARGE/);
    expect(() => uint32BE(1.5)).toThrow(/ARCHIVE_RECORD_TOO_LARGE/);
  });
});

// ────────────────────────────────────────────────────────────────
// Streamed db across read-stream chunk boundaries
// ────────────────────────────────────────────────────────────────

describe('archive export — streamed db', () => {
  it('a multi-chunk db round-trips byte-exact', async () => {
    // ~1 MB+ db → many 64 KB read-stream chunks → the streamed cipher is
    // fed in pieces. A boundary bug would corrupt the restored db.
    h = newHarness(5000);
    const key = mkKey(5);
    const archivePath = join(h.dir, 'big.recued.archive');
    const res = await exportArchive({
      destPath: archivePath,
      recoveryKey: key,
      db: h.db,
      producerVersion: '0.2.0',
    });
    expect(res.bytes_written).toBe(statSync(archivePath).size);

    const imported = await importArchive({ archivePath, recoveryKey: key, consumerVersion: '0.2.0' });
    // Manifest db size matches the decrypted db exactly.
    expect(imported.manifest.db_size_bytes).toBe(imported.db.length);
    expect(imported.db.length).toBeGreaterThan(64 * 1024); // truly multi-chunk

    const restorePath = join(h.dir, 'restored.db');
    writeFileSync(restorePath, imported.db);
    const restored = new Database(restorePath, { readonly: true });
    const count = restored.prepare('SELECT COUNT(*) AS n FROM example').get() as { n: number };
    expect(count.n).toBe(5000);
    const row = restored.prepare('SELECT v FROM example WHERE k = ?').get('k4999') as { v: string };
    expect(row.v).toBe(`v4999-${'x'.repeat(200)}`);
    restored.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Temp-file hygiene — no residue on success OR failure
// ────────────────────────────────────────────────────────────────

describe('archive export — temp hygiene', () => {
  const tempArtifacts = (dest: string): { dbTmp: boolean; partial: boolean } => ({
    dbTmp: readdirSync(h.dir).some((name) => name.startsWith(EXPORT_DB_SCRATCH_PREFIX)),
    partial: existsSync(`${dest}.partial`),
  });

  it('leaves no temp db / partial after a successful export', async () => {
    h = newHarness(50);
    const dest = join(h.dir, 'ok.recued.archive');
    await exportArchive({ destPath: dest, recoveryKey: mkKey(6), db: h.db, producerVersion: '0.2.0' });
    expect(existsSync(dest)).toBe(true);
    expect(tempArtifacts(dest)).toEqual({ dbTmp: false, partial: false });
  });

  it('reclaims the temp db copy when a referenced blob is absent', async () => {
    h = newHarness();
    const dest = join(h.dir, 'fail.recued.archive');
    const blobs = createBlobStore(join(h.dir, 'blobs'));
    await expect(exportArchive({
      destPath: dest,
      recoveryKey: mkKey(7),
      db: h.db,
      blobs,
      blobHashes: ['deadbeef-not-in-cas'],
      producerVersion: '0.2.0',
    })).rejects.toThrow(/ARCHIVE_BLOB_MISSING/);
    // The db backup ran before the blob size-pass threw — it must NOT be
    // stranded (the no-SSH-user GB-residue guard), and no torn archive.
    expect(existsSync(dest)).toBe(false);
    expect(tempArtifacts(dest)).toEqual({ dbTmp: false, partial: false });
  });

  it('reclaims the temp db AND the partial archive on a MID-STREAM failure', async () => {
    h = newHarness();
    const dest = join(h.dir, 'racy.recued.archive');
    // A blob that passes the up-front `sizeOf` pass but `getStream`s as null —
    // the documented race (deleted between sizing and assembly). The throw
    // lands DURING the pipeline, after MAGIC + manifest + the db record have
    // already been written to `.partial`, so this exercises cleanup of an
    // actually-created partial archive (not just a pre-pipeline abort).
    const racy: BlobStore = {
      sizeOf: async (hsh) => (hsh === 'vanishing' ? 1024 : null),
      get: async () => null,
      getStream: async () => null,
      put: async () => '', has: async () => false, delete: async () => {},
      sweepOrphans: async () => 0, totalBytes: async () => 0,
      root: join(h.dir, 'fake-blobs'),
    };
    await expect(exportArchive({
      destPath: dest,
      recoveryKey: mkKey(8),
      db: h.db,
      blobs: racy,
      blobHashes: ['vanishing'],
      producerVersion: '0.2.0',
    })).rejects.toThrow(/ARCHIVE_BLOB_MISSING/);
    expect(existsSync(dest)).toBe(false);
    expect(tempArtifacts(dest)).toEqual({ dbTmp: false, partial: false });
  });

  it('refuses a pre-existing partial without following or deleting it', async () => {
    h = newHarness();
    const dest = join(h.dir, 'occupied.recued.archive');
    const partial = `${dest}.partial`;
    writeFileSync(partial, 'belongs to another export');

    await expect(exportArchive({
      destPath: dest,
      recoveryKey: mkKey(9),
      db: h.db,
      producerVersion: '0.2.0',
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(partial, 'utf8')).toBe('belongs to another export');
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(h.dir).some((name) => name.startsWith(EXPORT_DB_SCRATCH_PREFIX)))
      .toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// M4b.0 — createRecordDecipher (the streaming counterpart to decryptRecord)
// ────────────────────────────────────────────────────────────────

describe('createRecordDecipher', () => {
  const key = mkKey(44);

  // Frame plaintext into a record body via the streaming cipher.
  const enc = (plain: Buffer): Buffer => {
    const c = createRecordCipher(key);
    return Buffer.concat([c.iv, c.update(plain), c.final()]);
  };

  // Decrypt a body by feeding the ciphertext through the decipher in the
  // given chunk sizes (remainder after the listed sizes goes in one piece).
  const streamDecrypt = (body: Buffer, ctChunkSizes: number[], k = key): Buffer => {
    const iv = body.subarray(0, IV_LEN);
    const tag = body.subarray(body.length - AEAD_TAG_LEN);
    const ct = body.subarray(IV_LEN, body.length - AEAD_TAG_LEN);
    const d = createRecordDecipher(k, iv);
    const parts: Buffer[] = [];
    let off = 0;
    for (const n of ctChunkSizes) {
      const pt = d.update(ct.subarray(off, off + n));
      if (pt.length) parts.push(pt);
      off += n;
    }
    if (off < ct.length) {
      const pt = d.update(ct.subarray(off));
      if (pt.length) parts.push(pt);
    }
    const fin = d.final(tag);
    if (fin.length) parts.push(fin);
    return Buffer.concat(parts);
  };

  it('round-trips plaintext across multiple ct chunks', () => {
    const plain = Buffer.from('y'.repeat(5000), 'utf8');
    const body = enc(plain);
    expect(streamDecrypt(body, [1000, 2500]).equals(plain)).toBe(true);
  });

  it('round-trips empty plaintext (iv + tag only)', () => {
    const body = enc(Buffer.alloc(0));
    expect(body.length).toBe(IV_LEN + AEAD_TAG_LEN);
    expect(streamDecrypt(body, []).length).toBe(0);
  });

  it('throws on a tampered tag', () => {
    const body = enc(Buffer.from('secret', 'utf8'));
    const iv = body.subarray(0, IV_LEN);
    const tag = Buffer.from(body.subarray(body.length - AEAD_TAG_LEN));
    tag[0] ^= 0x01;
    const ct = body.subarray(IV_LEN, body.length - AEAD_TAG_LEN);
    const d = createRecordDecipher(key, iv);
    d.update(ct);
    expect(() => d.final(tag)).toThrow();
  });

  it('throws on the wrong key', () => {
    const body = enc(Buffer.from('secret', 'utf8'));
    expect(() => streamDecrypt(body, [], mkKey(77))).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// M4b.0 — streaming import end to end (memory-safe restore)
// ────────────────────────────────────────────────────────────────

describe('streamImportArchive — end to end', () => {
  const restoreDirs: string[] = [];
  afterEach(() => {
    while (restoreDirs.length) {
      try { rmSync(restoreDirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
    }
  });
  const newRestoreDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'archive-stream-restore-'));
    restoreDirs.push(d);
    return d;
  };

  it('streams a multi-chunk db to disk via applyRestore (byte-exact rows)', async () => {
    // ~1 MB+ db → the importer's read stream feeds the file sink in many
    // chunks; a boundary bug would corrupt the restored db.
    h = newHarness(5000);
    const key = mkKey(21);
    const archivePath = join(h.dir, 'big.recued.archive');
    await exportArchive({ destPath: archivePath, recoveryKey: key, db: h.db, producerVersion: '0.2.0' });

    const tgt = newRestoreDir();
    const dbPath = join(tgt, 'recued-server.db');
    const res = await applyRestore(
      { dbPath, dataPath: tgt, configPath: null },
      { archivePath, recoveryKey: key, consumerVersion: '0.2.0' },
    );
    expect(res.db_bytes).toBeGreaterThan(64 * 1024); // truly multi-chunk

    const restored = new Database(dbPath, { readonly: true });
    const count = restored.prepare('SELECT COUNT(*) AS n FROM example').get() as { n: number };
    expect(count.n).toBe(5000);
    const row = restored.prepare('SELECT v FROM example WHERE k = ?').get('k4999') as { v: string };
    expect(row.v).toBe(`v4999-${'x'.repeat(200)}`);
    restored.close();
  });

  it('summarizeArchive validates + sizes without restoring anything', async () => {
    h = newHarness(20);
    const key = mkKey(22);
    const configPath = join(h.dir, 'config.toml');
    writeFileSync(configPath, '[bootstrap]\nbind_port = 7717\n');
    const archivePath = join(h.dir, 'sum.recued.archive');
    await exportArchive({ destPath: archivePath, recoveryKey: key, db: h.db, configPath, producerVersion: '0.2.0' });

    const summary = await summarizeArchive({ archivePath, recoveryKey: key, consumerVersion: '0.2.0' });
    expect(summary.manifest.producer_version).toBe('0.2.0');
    // db plaintext size matches the manifest's recorded size.
    expect(summary.dbBytes).toBe(summary.manifest.db_size_bytes);
    expect(summary.blobCount).toBe(0);
    expect(summary.smallRecordBytes['config.toml']).toBeGreaterThan(0);
  });

  it('rejects a truncated archive (chopped HMAC trailer) and leaves no temp', async () => {
    h = newHarness(3);
    const key = mkKey(23);
    const archivePath = join(h.dir, 'trunc.recued.archive');
    await exportArchive({ destPath: archivePath, recoveryKey: key, db: h.db, producerVersion: '0.2.0' });
    const full = readFileSync(archivePath);
    writeFileSync(archivePath, full.subarray(0, full.length - 10)); // chop into the trailer

    const tgt = newRestoreDir();
    await expect(
      applyRestore(
        { dbPath: join(tgt, 'recued-server.db'), dataPath: tgt, configPath: null },
        { archivePath, recoveryKey: key, consumerVersion: '0.2.0' },
      ),
    ).rejects.toThrow(/ARCHIVE_TRUNCATED/); // structural check fires before the HMAC compare

    // No db, no temp restore file left behind on the abort.
    expect(existsSync(join(tgt, 'recued-server.db'))).toBe(false);
    expect(readdirSync(tgt).some((f) => f.includes('.restore-'))).toBe(false);
  });
});
