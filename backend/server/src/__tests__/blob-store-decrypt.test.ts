/** CAS blob-store `decryptToFile` streaming decrypt-to-scratch (blob-encryption
 *  fix Phase 2). The archive export carries PLAINTEXT, so an ENCRYPTED store's
 *  blobs must be decrypted (tag-verified) before streaming into the archive.
 *  `decryptToFile` is the exact reverse of `putFile`'s stream-encrypt: it
 *  streams the on-disk `iv || ct || tag` through a GCM decipher into a scratch
 *  file, verifying the tag at `final()` — and on ANY failure it deletes the
 *  scratch so a caller reading it post-resolution never sees unverified bytes.
 *
 *  Also pins `plaintextSizeOf` (plaintext length without decrypting) and the
 *  `encrypted` posture flag the export branches on.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBlobStore } from '../storage/blob-store.js';

let root: string;
let scratch: string;
const key = randomBytes(32);
const pathFor = (casRoot: string, hash: string): string =>
  join(casRoot, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blob-store-decrypt-'));
  scratch = join(root, 'scratch.tmp');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('blob-store decryptToFile (encrypted → scratch plaintext)', () => {
  // SYNC key provider — an async one silently yields a Promise → "key must be
  // 32 bytes" (the trap the Phase-1 handover flags).
  const enc = () => createBlobStore(root, { getEncryptionKey: () => key });

  it('round-trips: encrypted blob decrypts to the exact plaintext', async () => {
    const store = enc();
    const plaintext = randomBytes(200_000); // multi-chunk → exercises streaming
    const hash = await store.put(plaintext);
    // On disk it is ciphertext, not the plaintext.
    expect(readFileSync(pathFor(root, hash)).equals(plaintext)).toBe(false);

    await store.decryptToFile!(hash, scratch);
    expect(readFileSync(scratch).equals(plaintext)).toBe(true);
  });

  it('round-trips a 0-byte plaintext blob (empty ciphertext span)', async () => {
    const store = enc();
    const hash = await store.put(Buffer.alloc(0));
    await store.decryptToFile!(hash, scratch);
    expect(readFileSync(scratch).length).toBe(0);
  });

  it('tampered ciphertext → throws (GCM tag) AND deletes the scratch', async () => {
    const store = enc();
    const hash = await store.put(randomBytes(5000));
    const onDisk = readFileSync(pathFor(root, hash));
    onDisk[20] ^= 0xff; // flip a ciphertext byte (past the 12-byte iv)
    writeFileSync(pathFor(root, hash), onDisk);

    await expect(store.decryptToFile!(hash, scratch)).rejects.toThrow();
    // Nothing may be left for a consumer to read.
    expect(existsSync(scratch)).toBe(false);
  });

  it('tampered auth tag → throws AND deletes the scratch', async () => {
    const store = enc();
    const hash = await store.put(randomBytes(5000));
    const onDisk = readFileSync(pathFor(root, hash));
    onDisk[onDisk.length - 1] ^= 0xff; // flip the last tag byte
    writeFileSync(pathFor(root, hash), onDisk);

    await expect(store.decryptToFile!(hash, scratch)).rejects.toThrow();
    expect(existsSync(scratch)).toBe(false);
  });

  it('absent blob → throws ARCHIVE_BLOB_MISSING', async () => {
    const store = enc();
    await expect(store.decryptToFile!('deadbeef'.repeat(8), scratch)).rejects.toThrow(
      /ARCHIVE_BLOB_MISSING/,
    );
  });

  it('keyless store → decryptToFile throws (nothing to decrypt; use getStream)', async () => {
    const store = createBlobStore(root);
    const hash = await store.put(randomBytes(1000));
    await expect(store.decryptToFile!(hash, scratch)).rejects.toThrow(/encryption mode/);
  });

  // This is the one place a keyed blob's plaintext exists as a file, so it must
  // not be readable by anyone but the owner for the moment it does.
  it('the scratch plaintext is owner-only', async () => {
    if (process.platform === 'win32') return; // no POSIX mode bits
    const store = enc();
    const hash = await store.put(randomBytes(5000));
    await store.decryptToFile!(hash, scratch);
    expect(statSync(scratch).mode & 0o077).toBe(0);
  });
});

describe('blob-store plaintextSizeOf + encrypted flag', () => {
  it('encrypted: plaintextSizeOf is the plaintext length (< the on-disk size)', async () => {
    const store = createBlobStore(root, { getEncryptionKey: () => key });
    const plaintext = randomBytes(12_345);
    const hash = await store.put(plaintext);
    expect(await store.plaintextSizeOf!(hash)).toBe(12_345);
    // On-disk is plaintext + iv(12) + tag(16) = plaintext + 28.
    expect(await store.sizeOf(hash)).toBe(12_345 + 28);
    expect(store.encrypted).toBe(true);
  });

  it('keyless: plaintextSizeOf equals sizeOf; encrypted flag is false', async () => {
    const store = createBlobStore(root);
    const plaintext = randomBytes(4096);
    const hash = await store.put(plaintext);
    expect(await store.plaintextSizeOf!(hash)).toBe(4096);
    expect(await store.sizeOf(hash)).toBe(4096);
    expect(store.encrypted).toBe(false);
  });

  it('plaintextSizeOf returns null for an absent blob', async () => {
    const store = createBlobStore(root, { getEncryptionKey: () => key });
    expect(await store.plaintextSizeOf!('cafe'.repeat(16))).toBeNull();
  });
});
