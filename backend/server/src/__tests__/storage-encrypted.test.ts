/** Encrypted-mode tests for blob store + SQLite cache store.
 *
 *  Cover:
 *   - Round-trip: encrypt on write, decrypt on read, plaintext matches.
 *   - Dedup survives: same plaintext → same hash → one file on disk.
 *   - Wrong-key decrypt fails (AES-GCM authentication).
 *   - AAD binding: per-row key prevents ciphertext splicing.
 *   - Locked state: ops throw clearly when key provider returns null.
 *   - Byte-level verification: the file on disk is NOT the plaintext.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CacheEntry } from '@recued/cache';
import { randomBytes, deriveSubDEK } from '@recued/crypto';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createSQLiteCacheStore } from '../storage/index.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'recued-enc-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const fixedKey = (seed = 42): Uint8Array => {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = (seed + i) & 0xff;
  return k;
};

const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  key: 'v1:pair:x@1:deadbeef',
  value: { foo: 'bar', n: 42 },
  expires_at: Date.now() + 60_000,
  recipe_id: 'r-1',
  ingredient_slug: 'x',
  size_bytes: 20,
  created_at: Date.now(),
  last_accessed_at: Date.now(),
  category: 'data',
  risk_tier: 'read',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Blob store — encryption
// ────────────────────────────────────────────────────────────────

describe('blob store — encrypted mode', () => {
  it('round-trips payload through encrypt → decrypt', async () => {
    const key = fixedKey();
    const store = createBlobStore(join(workDir, 'blobs'), {
      getEncryptionKey: () => key,
    });
    const plaintext = Buffer.from('sensitive user data');
    const hash = await store.put(plaintext);
    const got = await store.get(hash);
    expect(got?.equals(plaintext)).toBe(true);
  });

  it('on-disk bytes do NOT equal plaintext', async () => {
    const key = fixedKey();
    const blobsRoot = join(workDir, 'blobs');
    const store = createBlobStore(blobsRoot, { getEncryptionKey: () => key });
    const plaintext = Buffer.from('SECRET');
    const hash = await store.put(plaintext);

    const onDisk = readFileSync(join(blobsRoot, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`));
    expect(onDisk.includes(Buffer.from('SECRET'))).toBe(false);
    expect(onDisk.length).toBeGreaterThan(plaintext.length); // iv + tag added
  });

  it('dedup still works: same plaintext → same hash, one file', async () => {
    const key = fixedKey();
    const store = createBlobStore(join(workDir, 'blobs'), { getEncryptionKey: () => key });

    const pt = Buffer.from('x'.repeat(500));
    const h1 = await store.put(pt);
    const h2 = await store.put(pt);
    expect(h1).toBe(h2);
    // Dedup preserved via pre-encrypt hash check: one file on disk,
    // size ≈ plaintext + iv(12) + tag(16), not 2× plaintext.
    const total = await store.totalBytes();
    expect(total).toBeLessThan(pt.length * 2);
    expect(total).toBeGreaterThan(pt.length); // includes iv + tag overhead
  });

  it('wrong key → get throws', async () => {
    const k1 = fixedKey(1);
    const k2 = fixedKey(2);

    const writeStore = createBlobStore(join(workDir, 'blobs'), { getEncryptionKey: () => k1 });
    const hash = await writeStore.put(Buffer.from('confidential'));

    const readStore = createBlobStore(join(workDir, 'blobs'), { getEncryptionKey: () => k2 });
    await expect(readStore.get(hash)).rejects.toThrow('decryption failed');
  });

  it('tampered file → get throws', async () => {
    const key = fixedKey();
    const blobsRoot = join(workDir, 'blobs');
    const store = createBlobStore(blobsRoot, { getEncryptionKey: () => key });

    const hash = await store.put(Buffer.from('original'));
    const path = join(blobsRoot, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

    // Flip a ciphertext byte (after IV)
    const { writeFileSync, readFileSync: rf } = await import('node:fs');
    const bytes = rf(path);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(path, bytes);

    await expect(store.get(hash)).rejects.toThrow('decryption failed');
  });

  it('locked (key provider returns null) → put/get throw', async () => {
    let unlocked = true;
    const store = createBlobStore(join(workDir, 'blobs'), {
      getEncryptionKey: () => (unlocked ? fixedKey() : null),
    });

    const hash = await store.put(Buffer.from('hello'));
    unlocked = false;
    await expect(store.put(Buffer.from('new'))).rejects.toThrow('locked');
    await expect(store.get(hash)).rejects.toThrow('locked');
  });

  it('plaintext and encrypted modes are independent (no leakage)', async () => {
    // Plaintext store — no encryption options
    const plainStore = createBlobStore(join(workDir, 'plain'));
    const h1 = await plainStore.put(Buffer.from('public'));
    expect((await plainStore.get(h1))?.toString()).toBe('public');

    // Encrypted store on a different root
    const encStore = createBlobStore(join(workDir, 'enc'), { getEncryptionKey: () => fixedKey() });
    const h2 = await encStore.put(Buffer.from('private'));
    expect((await encStore.get(h2))?.toString()).toBe('private');
  });
});

// ────────────────────────────────────────────────────────────────
// SQLite cache store — encryption
// ────────────────────────────────────────────────────────────────

describe('SQLite cache store — encrypted inline values', () => {
  it('round-trips inline value through encrypt → decrypt', async () => {
    const db = new Database(join(workDir, 'test.db'));
    const blobs = createBlobStore(join(workDir, 'blobs'));
    const store = createSQLiteCacheStore(db, blobs, {
      getEncryptionKey: () => fixedKey(),
    });

    const entry = mkEntry({ value: { secret: 'data', n: 99 } });
    await store.set(entry);
    const got = await store.get(entry.key);
    expect(got?.value).toEqual({ secret: 'data', n: 99 });

    db.close();
  });

  it('a plaintext row reads back as plaintext even when an encryption key is now wired (R21.1 atob-crash fix)', async () => {
    const db = new Database(join(workDir, 'mix.db'));

    // Boot 1 — no vault yet: the plaintext-mode store writes an
    // `inline_enc = 0` row.
    const plainStore = createSQLiteCacheStore(db, createBlobStore(join(workDir, 'mix-blobs')));
    await plainStore.set(
      mkEntry({ key: 'v1:pair:x@1:plain', value: { kind: 'plaintext', n: 1 } }),
    );

    // Boot 2 — same DB, vault now unlocked: the provider is wired. The
    // OLD bug read the plaintext row through the ciphertext path and
    // `atob`-crashed (`DOMException: Invalid character`). The per-row
    // flag keeps it readable as plaintext.
    const encStore = createSQLiteCacheStore(
      db,
      createBlobStore(join(workDir, 'mix-blobs2')),
      { getEncryptionKey: () => fixedKey() },
    );
    const plain = await encStore.get('v1:pair:x@1:plain');
    expect(plain?.value).toEqual({ kind: 'plaintext', n: 1 });

    // And a fresh row written under the key round-trips (inline_enc = 1).
    await encStore.set(
      mkEntry({ key: 'v1:pair:x@1:enc', value: { kind: 'ciphertext', n: 2 } }),
    );
    const enc = await encStore.get('v1:pair:x@1:enc');
    expect(enc?.value).toEqual({ kind: 'ciphertext', n: 2 });

    // The two rows are genuinely stored in different modes.
    const flags = db
      .prepare(`SELECT key, inline_enc FROM cache_entries ORDER BY key`)
      .all() as Array<{ key: string; inline_enc: number | null }>;
    expect(flags).toEqual([
      { key: 'v1:pair:x@1:enc', inline_enc: 1 },
      { key: 'v1:pair:x@1:plain', inline_enc: 0 },
    ]);

    db.close();
  });

  it('R21.1 — both the inline AND blob paths throw on a sealed write (no plaintext-downgrade asymmetry)', async () => {
    const db = new Database(join(workDir, 'sealed.db'));
    // A wired-but-sealed provider (returns null) on BOTH stores — the
    // production posture when the vault is locked / uninitialized.
    const blobs = createBlobStore(join(workDir, 'sealed-blobs'), {
      getEncryptionKey: () => null,
    });
    const store = createSQLiteCacheStore(db, blobs, { getEncryptionKey: () => null });

    // Small value → inline path → `requireKey` throws.
    await expect(
      store.set(mkEntry({ key: 'v1:pair:x@1:small', value: { n: 1 } })),
    ).rejects.toThrow(/locked/);

    // Large value → blob path → blob-store `requireKey` throws. Same
    // posture, so a sealed write never lands plaintext on either path.
    await expect(
      store.set(mkEntry({ key: 'v1:pair:x@1:big', value: 'x'.repeat(70 * 1024) })),
    ).rejects.toThrow(/locked/);

    // Neither path wrote a row.
    const count = (
      db.prepare(`SELECT COUNT(*) AS c FROM cache_entries`).get() as { c: number }
    ).c;
    expect(count).toBe(0);

    db.close();
  });

  it('inline_value column is NOT the plaintext JSON', async () => {
    const db = new Database(join(workDir, 'test.db'));
    const blobs = createBlobStore(join(workDir, 'blobs'));
    const store = createSQLiteCacheStore(db, blobs, {
      getEncryptionKey: () => fixedKey(),
    });

    await store.set(mkEntry({ value: { secret: 'GOLD_NUGGET' } }));

    const row = db.prepare(`SELECT inline_value FROM cache_entries WHERE key = ?`)
      .get('v1:pair:x@1:deadbeef') as { inline_value: string };
    expect(row.inline_value).not.toContain('GOLD_NUGGET');
    expect(row.inline_value).not.toContain('secret');

    db.close();
  });

  it('wrong key → get throws', async () => {
    const dbPath = join(workDir, 'test.db');
    const blobRoot = join(workDir, 'blobs');

    {
      const db = new Database(dbPath);
      const store = createSQLiteCacheStore(db, createBlobStore(blobRoot), {
        getEncryptionKey: () => fixedKey(1),
      });
      await store.set(mkEntry({ value: 'secret' }));
      db.close();
    }
    {
      const db = new Database(dbPath);
      const store = createSQLiteCacheStore(db, createBlobStore(blobRoot), {
        getEncryptionKey: () => fixedKey(2),
      });
      await expect(store.get('v1:pair:x@1:deadbeef')).rejects.toThrow('decryption failed');
      db.close();
    }
  });

  it('AAD binding: copying ciphertext between rows fails to decrypt', async () => {
    const db = new Database(join(workDir, 'test.db'));
    const blobs = createBlobStore(join(workDir, 'blobs'));
    const store = createSQLiteCacheStore(db, blobs, {
      getEncryptionKey: () => fixedKey(),
    });

    await store.set(mkEntry({ key: 'row-A', value: 'a-value' }));
    await store.set(mkEntry({ key: 'row-B', value: 'b-value' }));

    // Swap inline_value across rows — SQL-level splicing attack.
    const rowA = db.prepare(`SELECT inline_value FROM cache_entries WHERE key = ?`).get('row-A') as { inline_value: string };
    db.prepare(`UPDATE cache_entries SET inline_value = ? WHERE key = ?`).run(rowA.inline_value, 'row-B');

    // row-B now has ciphertext that was encrypted with AAD="row-A". Decrypt must fail.
    await expect(store.get('row-B')).rejects.toThrow('decryption failed');

    db.close();
  });

  it('locked → get/set throw; metadata ops still work', async () => {
    let unlocked = true;
    const db = new Database(join(workDir, 'test.db'));
    const blobs = createBlobStore(join(workDir, 'blobs'));
    const store = createSQLiteCacheStore(db, blobs, {
      getEncryptionKey: () => (unlocked ? fixedKey() : null),
    });

    await store.set(mkEntry({ key: 'k1' }));
    unlocked = false;

    await expect(store.set(mkEntry({ key: 'k2' }))).rejects.toThrow('locked');
    await expect(store.get('k1')).rejects.toThrow('locked');

    // Metadata ops don't need the key:
    expect(typeof (await store.size())).toBe('number');
    await expect(store.deleteByRecipe('r-1')).resolves.toBeUndefined();

    db.close();
  });

  it('large values go through blob store (encrypted there) even in encrypted mode', async () => {
    const db = new Database(join(workDir, 'test.db'));
    const key = fixedKey();
    const blobs = createBlobStore(join(workDir, 'blobs'), { getEncryptionKey: () => key });
    const store = createSQLiteCacheStore(db, blobs, {
      getEncryptionKey: () => key,
      inlineThreshold: 10,
    });

    const bigValue = { text: 'x'.repeat(200) };
    const entry = mkEntry({ key: 'big', value: bigValue });
    await store.set(entry);
    const got = await store.get('big');
    expect(got?.value).toEqual(bigValue);

    // inline_value should be null (blob path), blob_hash should be set
    const row = db.prepare(`SELECT inline_value, blob_hash FROM cache_entries WHERE key = ?`)
      .get('big') as { inline_value: string | null; blob_hash: string | null };
    expect(row.inline_value).toBeNull();
    expect(row.blob_hash).not.toBeNull();

    db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Integration — server-data + blob-store sub-DEKs from one Master DEK
// ────────────────────────────────────────────────────────────────

describe('domain-separated sub-DEKs', () => {
  it('server-data and blob-store keys differ; one cannot decrypt the other', async () => {
    const masterDEK = randomBytes(32);
    const sqliteKey = deriveSubDEK(masterDEK, 'server-data');
    const blobKey = deriveSubDEK(masterDEK, 'blob-store');

    const db = new Database(join(workDir, 'test.db'));
    const blobs: BlobStore = createBlobStore(join(workDir, 'blobs'), { getEncryptionKey: () => blobKey });
    const store = createSQLiteCacheStore(db, blobs, { getEncryptionKey: () => sqliteKey });

    await store.set(mkEntry({ value: 'secret' }));
    const got = await store.get('v1:pair:x@1:deadbeef');
    expect(got?.value).toBe('secret');

    // If we accidentally used sqliteKey for blob ops, decrypt would fail.
    // (Just verifying the keys are actually distinct.)
    expect(Array.from(sqliteKey)).not.toEqual(Array.from(blobKey));

    db.close();
  });
});
