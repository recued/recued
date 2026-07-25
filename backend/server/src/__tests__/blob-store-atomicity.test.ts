/** CAS blob-store partial-write atomicity (Codex reception pass-2 follow-on).
 *
 *  put() publishes a blob via write-temp + atomic rename, never a direct write
 *  to the content-addressed .bin path. A torn write (crash / ENOSPC /
 *  concurrent interleave) may leave at most an orphan `.tmp-` file — never a
 *  truncated canonical .bin that the dedup exists-check would forever treat as
 *  authoritative (and that, encrypted, would fail GCM auth on every read).
 *
 *  node:fs/promises is mocked (passthrough by default) so the tests can:
 *    - PROVE the mechanism: writeFile lands on a `.tmp-` path, rename moves it
 *      onto the canonical `.bin` — the canonical path is NEVER written directly;
 *    - exercise the catch branch on rename FAILURE (no torn `.bin`, temp reaped,
 *      error rethrown);
 *    - exercise the concurrent-winner branch (EEXIST + valid dest → success).
 *  sweepOrphans reaps clearly-stale `.tmp-` orphans (Q4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ctl = vi.hoisted(() => ({
  renameMode: 'real' as 'real' | 'throw' | 'winner',
  writeCalls: [] as string[],
  renameCalls: [] as Array<[string, string]>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (async (p: unknown, data: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string') ctl.writeCalls.push(p);
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(p, data, ...rest);
    }) as typeof actual.writeFile,
    rename: (async (src: string, dest: string) => {
      ctl.renameCalls.push([src, dest]);
      if (ctl.renameMode === 'throw') {
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      if (ctl.renameMode === 'winner') {
        // A concurrent sibling already published identical content; the OS then
        // reports EEXIST on our rename (Windows-style). dest is a VALID blob.
        await actual.writeFile(dest, await actual.readFile(src));
        await actual.unlink(src);
        throw Object.assign(new Error('dest exists'), { code: 'EEXIST' });
      }
      return actual.rename(src, dest);
    }) as typeof actual.rename,
  };
});

// Imported AFTER vi.mock so the SUT binds the mocked fs/promises.
const { createBlobStore } = await import('../storage/blob-store.js');

const sha256Hex = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const prefixDirFor = (casRoot: string, hash: string): string =>
  join(casRoot, 'objects', hash.slice(0, 2));
const binPathFor = (casRoot: string, hash: string): string =>
  join(prefixDirFor(casRoot, hash), `${hash.slice(2)}.bin`);

let root: string;
let cas: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blob-store-atomicity-'));
  cas = join(root, 'cas');
  ctl.renameMode = 'real';
  ctl.writeCalls = [];
  ctl.renameCalls = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('BlobStore.put — atomic-publish MECHANISM', () => {
  it('writes to a .tmp- file then renames onto .bin — never writes the canonical path directly', async () => {
    const blobs = createBlobStore(cas);
    const data = Buffer.from('mechanism check');
    const hash = await blobs.put(data);
    const canonical = binPathFor(cas, hash);

    // The ONLY writeFile target is the temp; the canonical path is never written.
    expect(ctl.writeCalls.length).toBe(1);
    expect(ctl.writeCalls[0]).toContain('.tmp-');
    expect(ctl.writeCalls[0]).not.toBe(canonical);

    // Exactly one rename, temp → canonical.
    expect(ctl.renameCalls.length).toBe(1);
    const [src, dest] = ctl.renameCalls[0];
    expect(src).toContain('.tmp-');
    expect(dest).toBe(canonical);

    expect(await blobs.get(hash)).toEqual(data);
    expect(await readdir(prefixDirFor(cas, hash))).toEqual([`${hash.slice(2)}.bin`]);
  });
});

describe('BlobStore.put — failure leaves NO torn canonical file', () => {
  it('rethrows on rename failure, writes no .bin, and reaps the temp', async () => {
    const blobs = createBlobStore(cas);
    const data = Buffer.from('would be torn under the old direct-write path');
    const hash = sha256Hex(data);

    ctl.renameMode = 'throw';
    await expect(blobs.put(data)).rejects.toThrow(/injected rename failure/);

    // No torn canonical blob the dedup check would forever trust.
    expect(existsSync(binPathFor(cas, hash))).toBe(false);
    // Temp cleaned up by the catch (no orphan).
    const entries = await readdir(prefixDirFor(cas, hash)).catch(() => [] as string[]);
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
    // And get() reports absence rather than corruption.
    expect(await blobs.get(hash)).toBeNull();
  });
});

describe('BlobStore.put — concurrent-winner branch', () => {
  it('absorbs EEXIST when a sibling already published identical content', async () => {
    const blobs = createBlobStore(cas);
    const data = Buffer.from('two writers, identical bytes');
    const hash = sha256Hex(data);

    ctl.renameMode = 'winner';
    // Despite our rename throwing EEXIST, the dest exists and is valid → success.
    await expect(blobs.put(data)).resolves.toBe(hash);
    expect(await blobs.get(hash)).toEqual(data);
    expect(await readdir(prefixDirFor(cas, hash))).toEqual([`${hash.slice(2)}.bin`]);
  });
});

describe('BlobStore.put — round-trips & dedup (real fs)', () => {
  it('plaintext round-trip leaves exactly one .bin, no temp orphan', async () => {
    const blobs = createBlobStore(cas);
    const data = Buffer.from('hello atomic world');
    const hash = await blobs.put(data);

    expect(hash).toBe(sha256Hex(data));
    expect(await blobs.get(hash)).toEqual(data);
    const entries = await readdir(prefixDirFor(cas, hash));
    expect(entries).toEqual([`${hash.slice(2)}.bin`]);
  });

  it('encrypted round-trip (GCM) leaves no temp orphan; hash is over plaintext', async () => {
    const key = new Uint8Array(randomBytes(32));
    const blobs = createBlobStore(cas, { getEncryptionKey: () => key });
    const data = Buffer.from('encrypted payload past the iv+tag floor');
    const hash = await blobs.put(data);

    expect(hash).toBe(sha256Hex(data));
    expect(await blobs.get(hash)).toEqual(data);
    const entries = await readdir(prefixDirFor(cas, hash));
    expect(entries).toEqual([`${hash.slice(2)}.bin`]);
  });

  it('re-put of identical content dedups without a temp', async () => {
    const blobs = createBlobStore(cas);
    const data = Buffer.from('dedup me');
    const h1 = await blobs.put(data);
    ctl.writeCalls = [];
    const h2 = await blobs.put(data);

    expect(h2).toBe(h1);
    expect(ctl.writeCalls.length).toBe(0); // existsSync short-circuit, no rewrite
    expect(await readdir(prefixDirFor(cas, h1))).toEqual([`${h1.slice(2)}.bin`]);
  });
});

describe('BlobStore.put — concurrent writers (real fs)', () => {
  it('collapses N concurrent identical puts to one readable .bin, no temps', async () => {
    const blobs = createBlobStore(cas);
    const data = Buffer.from('a'.repeat(4096));
    const hashes = await Promise.all(Array.from({ length: 16 }, () => blobs.put(data)));

    const expected = sha256Hex(data);
    expect(hashes.every((h) => h === expected)).toBe(true);
    expect(await blobs.get(expected)).toEqual(data);
    expect(await readdir(prefixDirFor(cas, expected))).toEqual([`${expected.slice(2)}.bin`]);
  });

  it('writes N distinct concurrent blobs, each readable', async () => {
    const blobs = createBlobStore(cas);
    const datas = Array.from({ length: 12 }, (_, i) =>
      Buffer.from(`distinct-${i}-${'x'.repeat(2048)}`),
    );
    const hashes = await Promise.all(datas.map((d) => blobs.put(d)));

    expect(new Set(hashes).size).toBe(datas.length);
    for (let i = 0; i < datas.length; i++) {
      expect(hashes[i]).toBe(sha256Hex(datas[i]));
      expect(await blobs.get(hashes[i])).toEqual(datas[i]);
    }
  });
});

describe('BlobStore.sweepOrphans — stale temp reaping', () => {
  it('reaps a clearly-stale .tmp- orphan but leaves a fresh one and kept blobs', async () => {
    const blobs = createBlobStore(cas);
    const keep = await blobs.put(Buffer.from('keep this'));
    const prefixDir = prefixDirFor(cas, keep);

    const stale = join(prefixDir, '.tmp-deadbeef-stale');
    const fresh = join(prefixDir, '.tmp-deadbeef-fresh');
    writeFileSync(stale, Buffer.from('abandoned partial'));
    writeFileSync(fresh, Buffer.from('in-flight partial'));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);

    const deleted = await blobs.sweepOrphans(new Set([keep]));

    expect(deleted).toBe(1); // the stale temp
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // young temp untouched (in-flight safe)
    expect(await blobs.has(keep)).toBe(true);
  });
});
