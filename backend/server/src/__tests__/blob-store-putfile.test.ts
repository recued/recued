/** CAS blob-store `putFile` streaming-put round-trip (D-172 ingest hardening).
 *
 *  `putFile(srcPath)` streams a source file into the CAS without ever holding
 *  the whole plaintext in memory — the inbound-producer path for large
 *  untrusted media. Its on-disk output MUST be byte-for-byte the format
 *  `put(Buffer)` produces (iv(12) || ciphertext || GCM tag(16), AAD = hex
 *  hash), so `get` / dedup / `sweepOrphans` keep working unchanged.
 *
 *  These tests pin exactly that: the streamed write decrypts back through the
 *  same `get` (Web Crypto) path, and a `put(Buffer)` and a `putFile` of
 *  identical bytes land at the SAME content address (dedup holds). The
 *  streaming encrypt uses Node's createCipheriv; the read uses
 *  `@recued/crypto`'s Web Crypto decrypt — this is the format-match proof.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { createBlobStore } from '../storage/blob-store.js';

/** Drain a Readable into one Buffer (peak in the test is fine; production never
 *  does this — that's the point of getStream). */
const drain = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

let root: string;
let cas: string;
let srcDir: string;
const key = randomBytes(32);

const pathFor = (casRoot: string, hash: string): string =>
  join(casRoot, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

const writeSrc = (name: string, bytes: Buffer): string => {
  const p = join(srcDir, name);
  writeFileSync(p, bytes);
  return p;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blob-store-putfile-'));
  cas = join(root, 'cas');
  srcDir = join(root, 'src');
  // The store creates the CAS dir; we create the source dir for the temp inputs.
  mkdirSync(srcDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('BlobStore.putFile — encrypted', () => {
  it('round-trips: a streamed put decrypts back through get()', async () => {
    const store = createBlobStore(cas, { getEncryptionKey: () => key });
    const bytes = randomBytes(200_000); // spans many read chunks
    const src = writeSrc('big.bin', bytes);

    const hash = await store.putFile!(src);
    const got = await store.get(hash);

    expect(got).not.toBeNull();
    expect(got!.equals(bytes)).toBe(true);
    // The on-disk blob is the encrypted form, never the plaintext.
    const onDisk = readFileSync(pathFor(cas, hash));
    expect(onDisk.equals(bytes)).toBe(false);
    // iv(12) + ciphertext(=plaintext len) + tag(16).
    expect(onDisk.length).toBe(12 + bytes.length + 16);
  });

  it('lands at the SAME content address as put(Buffer) of identical bytes (dedup holds)', async () => {
    const store = createBlobStore(cas, { getEncryptionKey: () => key });
    const bytes = Buffer.from('the same content, two ingest paths');
    const src = writeSrc('same.txt', bytes);

    const hViaBuffer = await store.put(bytes);
    const hViaFile = await store.putFile!(src);

    expect(hViaFile).toBe(hViaBuffer);
    // One backing file — putFile saw the existing dest and short-circuited.
    const prefixDir = join(cas, 'objects', hViaBuffer.slice(0, 2));
    expect(readdirSync(prefixDir).filter((f) => f.endsWith('.bin'))).toHaveLength(1);
  });

  it('a put(Buffer) blob is readable, and a putFile blob of the same bytes is too (cross-format)', async () => {
    // Distinct stores (fresh CAS each) so neither dedup-short-circuits the other.
    const storeA = createBlobStore(join(root, 'a'), { getEncryptionKey: () => key });
    const storeB = createBlobStore(join(root, 'b'), { getEncryptionKey: () => key });
    const bytes = randomBytes(70_000);
    const src = writeSrc('cross.bin', bytes);

    const hA = await storeA.put(bytes);
    const hB = await storeB.putFile!(src);
    expect(hB).toBe(hA);

    expect((await storeA.get(hA))!.equals(bytes)).toBe(true);
    expect((await storeB.get(hB))!.equals(bytes)).toBe(true);
  });

  it('handles an empty file', async () => {
    const store = createBlobStore(cas, { getEncryptionKey: () => key });
    const src = writeSrc('empty.bin', Buffer.alloc(0));
    const hash = await store.putFile!(src);
    const got = await store.get(hash);
    expect(got!.length).toBe(0);
  });

  it('reports locked when the key is unavailable', async () => {
    const store = createBlobStore(cas, { getEncryptionKey: () => null });
    const src = writeSrc('locked.bin', Buffer.from('x'));
    await expect(store.putFile!(src)).rejects.toThrow(/locked/);
  });
});

describe('BlobStore.putFile — plaintext', () => {
  it('round-trips without encryption and stores raw bytes', async () => {
    const store = createBlobStore(cas);
    const bytes = randomBytes(130_000);
    const src = writeSrc('plain.bin', bytes);

    const hash = await store.putFile!(src);
    const got = await store.get(hash);
    expect(got!.equals(bytes)).toBe(true);
    // Plaintext mode: the on-disk blob IS the raw bytes.
    expect(readFileSync(pathFor(cas, hash)).equals(bytes)).toBe(true);
  });

  it('matches put(Buffer) content address in plaintext mode', async () => {
    const store = createBlobStore(cas);
    const bytes = Buffer.from('plain dedup');
    const src = writeSrc('pd.txt', bytes);
    const hBuf = await store.put(bytes);
    const hFile = await store.putFile!(src);
    expect(hFile).toBe(hBuf);
  });
});

describe('BlobStore.putFile — dedup + sweep', () => {
  it('putFile twice yields one backing file', async () => {
    const store = createBlobStore(cas, { getEncryptionKey: () => key });
    const bytes = randomBytes(40_000);
    const src = writeSrc('dup.bin', bytes);
    const h1 = await store.putFile!(src);
    const h2 = await store.putFile!(src);
    expect(h2).toBe(h1);
    const prefixDir = join(cas, 'objects', h1.slice(0, 2));
    expect(readdirSync(prefixDir).filter((f) => f.endsWith('.bin'))).toHaveLength(1);
  });

  it('a putFile blob survives sweepOrphans when in the keep-set', async () => {
    const store = createBlobStore(cas, { getEncryptionKey: () => key });
    const bytes = randomBytes(5_000);
    const src = writeSrc('keep.bin', bytes);
    const hash = await store.putFile!(src);
    const deleted = await store.sweepOrphans(new Set([hash]));
    expect(deleted).toBe(0);
    expect(existsSync(pathFor(cas, hash))).toBe(true);
  });
});

describe('BlobStore.getStream — streaming read (M-blob)', () => {
  it('streams a present blob back byte-for-byte (plaintext / keyless)', async () => {
    const store = createBlobStore(cas);
    const bytes = randomBytes(200_000); // spans many read chunks
    const hash = await store.put(bytes);
    const stream = await store.getStream!(hash);
    expect(stream).not.toBeNull();
    expect((await drain(stream!)).equals(bytes)).toBe(true);
  });

  it('resolves null for an absent blob', async () => {
    const store = createBlobStore(cas);
    expect(await store.getStream!('deadbeef'.repeat(8))).toBeNull();
  });

  it('throws in encryption mode (a streaming decrypt would emit unverified plaintext)', async () => {
    const store = createBlobStore(cas, { getEncryptionKey: () => key });
    const hash = await store.put(Buffer.from('secret'));
    await expect(store.getStream!(hash)).rejects.toThrow(/not supported in encryption mode/);
  });
});
