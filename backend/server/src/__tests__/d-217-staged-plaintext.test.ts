/** D-217 slice 0 — staged plaintext + ranged read.
 *
 *  What is actually under test, in order of how badly it fails if wrong:
 *   1. **The staging file is reaped.** It holds warehouse PLAINTEXT on a disk
 *      whose whole point is ciphertext. `dispose()` covers the ordinary path;
 *      the boot sweep covers SIGKILL — and the sweep only covers a prefix it
 *      was told about, so that coupling is pinned here rather than assumed.
 *   2. **A range is exactly a range.** A short or over-running read produces a
 *      truncated upload the target accepts and stores as a corrupt asset.
 *   3. **The content pin is checked BEFORE the handle escapes** — after that,
 *      a mismatch means bytes already reached a third party.
 *   4. **An encrypted store goes through `decryptToFile`**, never `getStream`
 *      (which refuses in encryption mode by design, because it would emit
 *      plaintext before the GCM tag is verified).
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EGRESS_BLOB_SCRATCH_PREFIX,
  egressBlobScratchPath,
  sweepBlobScratch,
} from '../archive/archive-scratch.js';
import {
  stagePlaintext,
  type StagingBlobStore,
} from '../collections/file/staged-plaintext.js';

const dirs: string[] = [];
const mkDataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'd217-stage-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex');
const HASH = 'a'.repeat(64);

/** A keyless store with a real stream — the production keyless shape. */
const keylessStore = (bytes = CONTENT): StagingBlobStore => ({
  get: async () => bytes,
  sizeOf: async () => bytes.length,
  plaintextSizeOf: async () => bytes.length,
  getStream: async () => Readable.from([bytes]),
  encrypted: false,
});

/** An encrypted store: `getStream` THROWS (as the real one does) so a test can
 *  prove staging never reaches for it. */
const encryptedStore = (bytes = CONTENT): StagingBlobStore & {
  decryptToFile: (hash: string, dest: string) => Promise<void>;
} => ({
  get: async () => { throw new Error('get must not be used for a ranged read'); },
  sizeOf: async () => bytes.length + 28,
  plaintextSizeOf: async () => bytes.length,
  getStream: async () => { throw new Error('getStream is not supported in encryption mode'); },
  decryptToFile: async (_hash: string, dest: string) => {
    writeFileSync(dest, bytes, { mode: 0o600 });
  },
  encrypted: true,
});

const stage = (blobs: StagingBlobStore, dataPath: string, over: Record<string, unknown> = {}) =>
  stagePlaintext({
    blobs,
    dataPath,
    blob_hash: HASH,
    mime_type: 'video/mp4',
    filename: 'clip.mp4',
    ...over,
  });

// ════════════════════════════════════════════════════════════════════
// 1. the staging file's lifecycle — the plaintext-on-disk risk
// ════════════════════════════════════════════════════════════════════

describe('staged plaintext — lifecycle', () => {
  it('writes exactly one staging file and removes it on dispose', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    const during = readdirSync(dataPath).filter((n) => n.startsWith(EGRESS_BLOB_SCRATCH_PREFIX));
    expect(during).toHaveLength(1);

    await staged.dispose();
    expect(readdirSync(dataPath).filter((n) => n.startsWith(EGRESS_BLOB_SCRATCH_PREFIX)))
      .toHaveLength(0);
  });

  it('⛔ the boot sweep reaps a stranded egress file — the SIGKILL backstop', async () => {
    // `dispose()` cannot run after SIGKILL. If the sweep does not know this
    // prefix, warehouse plaintext survives on disk until someone notices.
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    const orphan = readdirSync(dataPath).find((n) => n.startsWith(EGRESS_BLOB_SCRATCH_PREFIX));
    expect(orphan).toBeDefined();

    // No dispose — simulate the hard kill.
    expect(sweepBlobScratch(dataPath)).toBe(1);
    expect(existsSync(join(dataPath, orphan!))).toBe(false);
    await staged.dispose();
  });

  it('dispose survives the file already being gone — the sweep-raced case', async () => {
    // The reason `removeFile` swallows: a boot sweep (or an operator) may have
    // taken the file first. A dispose that threw here would turn a benign race
    // into a failed upload teardown.
    //
    // ⚠ Deliberately NOT phrased as "dispose is idempotent" — a mutation
    // deleting the `if (disposed) return` guard leaves plain double-dispose
    // green, because the inner catches already absorb it. The guard's real job
    // is the read-after-dispose refusal, which is pinned separately.
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    expect(sweepBlobScratch(dataPath)).toBe(1);
    await expect(staged.dispose()).resolves.toBeUndefined();
    await expect(staged.dispose()).resolves.toBeUndefined();
  });

  it('a read after dispose is refused, not served from a closed handle', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    await staged.dispose();
    await expect(staged.read(0, 4)).rejects.toThrow(/after dispose/);
  });

  it('leaves NO plaintext behind when staging itself fails', async () => {
    const dataPath = mkDataDir();
    const broken: StagingBlobStore = {
      ...keylessStore(),
      getStream: async () => Readable.from([Buffer.from('x')]) ,
      plaintextSizeOf: async () => 999, // disagrees with what lands
    };
    await expect(stage(broken, dataPath)).rejects.toThrow(/declared 999/);
    expect(readdirSync(dataPath)).toHaveLength(0);
  });

  it('the staging name cannot carry a blob hash — the signature takes none', () => {
    // ⚠ Asserting `not.toContain(HASH)` on the RESULT would be vacuous: the
    // function never receives a hash, so that check passes for any
    // implementation. The real guarantee is structural — one parameter, the
    // data dir — so a future edit that threads a hash in has to change the
    // arity and trip this.
    expect(egressBlobScratchPath).toHaveLength(1);
    const p = egressBlobScratchPath('/data');
    expect(p.startsWith(`/data/${EGRESS_BLOB_SCRATCH_PREFIX}`)).toBe(true);
    expect(p.endsWith('.tmp')).toBe(true);
    // Two calls never collide — concurrent uploads stage side by side.
    expect(egressBlobScratchPath('/data')).not.toBe(p);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. ranges
// ════════════════════════════════════════════════════════════════════

describe('staged plaintext — ranged read', () => {
  it('returns exactly the requested window, at the requested offset', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    try {
      expect((await staged.read(0, 10)).toString()).toBe('0123456789');
      expect((await staged.read(10, 6)).toString()).toBe('abcdef');
      // The tail, exactly.
      expect((await staged.read(CONTENT.length - 3, 3)).toString()).toBe('xyz');
    } finally {
      await staged.dispose();
    }
  });

  it('reassembles to the original when walked in chunks', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    try {
      const CHUNK = 7;
      const parts: Buffer[] = [];
      for (let off = 0; off < staged.size_bytes; off += CHUNK) {
        parts.push(await staged.read(off, Math.min(CHUNK, staged.size_bytes - off)));
      }
      expect(Buffer.concat(parts).equals(CONTENT)).toBe(true);
    } finally {
      await staged.dispose();
    }
  });

  it('⛔ refuses a range that runs past the end rather than short-reading', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    try {
      await expect(staged.read(CONTENT.length - 2, 5)).rejects.toThrow(/runs past/);
      await expect(staged.read(CONTENT.length, 1)).rejects.toThrow(/runs past/);
    } finally {
      await staged.dispose();
    }
  });

  it('⛔ refuses a SHORT read — the file shrinking mid-upload', async () => {
    // The bounds check cannot catch this: the range was valid when staged.
    // Truncating the file underneath is the real scenario the guard names
    // ("the file changed under us"), and without the guard a chunk goes out
    // half-empty and the target stores a corrupt asset.
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    try {
      const name = readdirSync(dataPath).find((n) => n.startsWith(EGRESS_BLOB_SCRATCH_PREFIX))!;
      truncateSync(join(dataPath, name), 8);
      await expect(staged.read(4, 12)).rejects.toThrow(/short read at 4 \(wanted 12, got 4\)/);
    } finally {
      await staged.dispose();
    }
  });

  it('refuses a non-integer / negative / zero-length range', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    try {
      await expect(staged.read(-1, 4)).rejects.toThrow(/non-negative/);
      await expect(staged.read(1.5, 4)).rejects.toThrow(/non-negative/);
      await expect(staged.read(0, 0)).rejects.toThrow(/positive/);
      await expect(staged.read(0, -3)).rejects.toThrow(/positive/);
    } finally {
      await staged.dispose();
    }
  });

  it('reports the PLAINTEXT size, which is what a chunk plan divides', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(encryptedStore(), dataPath);
    try {
      // The encrypted store's `sizeOf` is +28 (envelope); the plan must not use it.
      expect(staged.size_bytes).toBe(CONTENT.length);
    } finally {
      await staged.dispose();
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. the content pin
// ════════════════════════════════════════════════════════════════════

describe('staged plaintext — content pin', () => {
  it('accepts a matching pin', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath, { expect_sha256: CONTENT_SHA });
    try {
      expect(staged.size_bytes).toBe(CONTENT.length);
    } finally {
      await staged.dispose();
    }
  });

  it('⛔ rejects a mismatched pin BEFORE any handle escapes, and removes the file', async () => {
    const dataPath = mkDataDir();
    await expect(stage(keylessStore(), dataPath, { expect_sha256: 'b'.repeat(64) }))
      .rejects.toThrow(/content pin mismatch/);
    // No handle was returned, so nothing could have been sent — and no
    // plaintext is left on disk.
    expect(readdirSync(dataPath)).toHaveLength(0);
  });

  it('pins the bytes that actually LANDED, not the ones the store claimed', async () => {
    // A store whose stream disagrees with the pin is exactly the swapped-carrier
    // case the pin exists for.
    const dataPath = mkDataDir();
    const swapped = keylessStore(Buffer.from('not-the-pinned-content', 'utf8'));
    await expect(stage(swapped, dataPath, { expect_sha256: CONTENT_SHA }))
      .rejects.toThrow(/content pin mismatch/);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. encryption mode
// ════════════════════════════════════════════════════════════════════

describe('staged plaintext — encryption mode', () => {
  it('⛔ decrypts via decryptToFile and never touches getStream', async () => {
    const dataPath = mkDataDir();
    const store = encryptedStore();
    const spy = vi.spyOn(store, 'decryptToFile');
    // `getStream` throws in this fake exactly as the real one does in
    // encryption mode, so reaching for it would fail the test loudly.
    const staged = await stage(store, dataPath);
    try {
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await staged.read(0, 4)).toString()).toBe('0123');
    } finally {
      await staged.dispose();
    }
  });

  it('refuses when an encrypted store cannot decrypt to a file', async () => {
    const dataPath = mkDataDir();
    const store = { ...encryptedStore() } as StagingBlobStore;
    delete (store as { decryptToFile?: unknown }).decryptToFile;
    await expect(stage(store, dataPath)).rejects.toThrow(/lacks decryptToFile/);
    expect(readdirSync(dataPath)).toHaveLength(0);
  });

  it('the staged file is owner-only', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath);
    try {
      const name = readdirSync(dataPath).find((n) => n.startsWith(EGRESS_BLOB_SCRATCH_PREFIX))!;
      const { statSync } = await import('node:fs');
      expect(statSync(join(dataPath, name)).mode & 0o777).toBe(0o600);
    } finally {
      await staged.dispose();
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. the size cap — refused without decrypting
// ════════════════════════════════════════════════════════════════════

describe('staged plaintext — size cap', () => {
  it('⛔ refuses an over-cap blob without decrypting or writing anything', async () => {
    const dataPath = mkDataDir();
    const store = encryptedStore();
    const spy = vi.spyOn(store, 'decryptToFile');
    await expect(stage(store, dataPath, { max_bytes: CONTENT.length - 1 }))
      .rejects.toThrow(/over the/);
    // The whole point: no AES work, no disk.
    expect(spy).not.toHaveBeenCalled();
    expect(readdirSync(dataPath)).toHaveLength(0);
  });

  it('accepts a blob exactly at the cap', async () => {
    const dataPath = mkDataDir();
    const staged = await stage(keylessStore(), dataPath, { max_bytes: CONTENT.length });
    try {
      expect(staged.size_bytes).toBe(CONTENT.length);
    } finally {
      await staged.dispose();
    }
  });

  it('reports a missing blob rather than staging an empty file', async () => {
    const dataPath = mkDataDir();
    const absent: StagingBlobStore = {
      get: async () => null,
      sizeOf: async () => null,
      plaintextSizeOf: async () => null,
    };
    await expect(stage(absent, dataPath)).rejects.toThrow(/blob missing/);
    expect(readdirSync(dataPath)).toHaveLength(0);
  });
});

// A guard on the fixture itself: if CONTENT ever changes, the range
// expectations above must be re-derived rather than silently drifting.
describe('fixture', () => {
  it('CONTENT is the 36-char ordered alphabet these ranges assume', () => {
    expect(CONTENT).toHaveLength(36);
    expect(readFileSync(new URL(import.meta.url)).length).toBeGreaterThan(0);
  });
});
