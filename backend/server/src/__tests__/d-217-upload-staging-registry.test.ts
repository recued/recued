/** D-217 slice 2b-ii — the staging registry, over the REAL slice-0 handle.
 *
 *  What is actually under test, in order of how badly it fails if wrong:
 *   1. **A token addresses one entry and nothing else.** It is a capability
 *      over decrypted warehouse plaintext. An unknown or disposed token must
 *      read NOTHING — never fall through to another entry, never open a path.
 *   2. **Disposal is complete and ordered.** The plaintext file goes, the entry
 *      goes, and the entry goes FIRST — a read racing a dispose must not be
 *      handed a handle whose file is already being unlinked.
 *   3. **A failed stage mints no token and leaks no entry.** A content-pin
 *      mismatch is the case D-217 § 8c exists for: it must be caught before
 *      anything is addressable, not one dispatch later.
 *   4. **Concurrent staging is bounded.** Each entry is up to 512 MB of
 *      plaintext in the data dir; unbounded, concurrent uploads fill the
 *      volume. Refusing to stage means the walk never starts, so no bytes
 *      leave — the fail-closed direction.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { EGRESS_BLOB_SCRATCH_PREFIX } from '../archive/archive-scratch.js';
import type { StagingBlobStore } from '../collections/file/staged-plaintext.js';
import {
  MAX_CONCURRENT_STAGED,
  createUploadStagingRegistry,
  type UploadStagingRegistry,
} from '../collections/file/upload-staging.js';
import type { InboundFileCollection } from '../collections/file/inbound-file-collection.js';

const dirs: string[] = [];
const mkDataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'd217-registry-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex');

const blobs = (bytes = CONTENT): StagingBlobStore => ({
  get: async () => bytes,
  sizeOf: async () => bytes.length,
  plaintextSizeOf: async () => bytes.length,
  getStream: async () => Readable.from([bytes]),
  encrypted: false,
});

/** The metadata half of the file collection — `get` only. Staging reads the
 *  BLOB, so a registry that reached for bytes here would defeat slice 0. */
const files = (
  overrides: Record<string, unknown> = {},
): Pick<InboundFileCollection, 'get'> => ({
  get: ((record_id: string) => {
    if (record_id === 'missing') return null;
    if (record_id === 'remote') {
      return {
        record_id,
        storage_ref: { kind: 'file_meta_ref', ref: 'provider:1' },
        hot_fields: { mime_type: 'video/mp4', filename: 'clip.mp4' },
      };
    }
    return {
      record_id,
      storage_ref: { kind: 'cas', blob_hash: 'a'.repeat(64) },
      hot_fields: { mime_type: 'video/mp4', filename: 'clip.mp4' },
      ...overrides,
    };
  }) as InboundFileCollection['get'],
});

const mk = (opts: { store?: StagingBlobStore; dataPath?: string } = {}): {
  registry: UploadStagingRegistry;
  dataPath: string;
} => {
  const dataPath = opts.dataPath ?? mkDataDir();
  return {
    registry: createUploadStagingRegistry({
      blobs: opts.store ?? blobs(),
      dataPath,
      files: files(),
    }),
    dataPath,
  };
};

const scratchFiles = (dataPath: string): string[] =>
  readdirSync(dataPath).filter((n) => n.startsWith(EGRESS_BLOB_SCRATCH_PREFIX));

describe('D-217 registry — a token addresses one entry and nothing else', () => {
  it('stages, reads a range, and reports the plaintext size', async () => {
    const { registry } = mk();
    const staged = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });

    expect(staged.size_bytes).toBe(CONTENT.length);
    expect(staged.mime_type).toBe('video/mp4');
    expect(staged.filename).toBe('clip.mp4');

    const { bytes, mime_type } = await registry.read(staged.token, 10, 6);
    expect(Buffer.from(bytes).toString('utf8')).toBe('abcdef');
    expect(mime_type).toBe('video/mp4');
    await registry.dispose(staged.token);
  });

  it('refuses an unknown token rather than serving any live entry', async () => {
    const { registry } = mk();
    const staged = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });
    // A live entry EXISTS — so a registry that fell back to "the one we have"
    // would pass a test that only checked the happy path.
    await expect(registry.read('not-a-token', 0, 4))
      .rejects.toThrow(/unknown or disposed staging token/);
    await registry.dispose(staged.token);
  });

  it('mints a DIFFERENT token per stage', async () => {
    const { registry } = mk();
    const a = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });
    const b = await registry.stage({ file_ref: 'f2', max_bytes: 1024 });
    expect(a.token).not.toBe(b.token);
    // Long enough not to be guessable by a racing recipe. 24 random bytes.
    expect(a.token).toMatch(/^[0-9a-f]{48}$/);
    await registry.disposeAll();
  });

  it('reads two different ranges from ONE stage — the whole reason for a handle', async () => {
    // A per-call `readFileRange` would decrypt the blob twice here. The
    // registry must keep the handle open across reads.
    const { registry, dataPath } = mk();
    const staged = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });
    expect(Buffer.from((await registry.read(staged.token, 0, 4)).bytes).toString()).toBe('0123');
    expect(Buffer.from((await registry.read(staged.token, 4, 4)).bytes).toString()).toBe('4567');
    expect(scratchFiles(dataPath)).toHaveLength(1);
    await registry.dispose(staged.token);
  });
});

describe('D-217 registry — disposal is complete, ordered, and idempotent', () => {
  it('unlinks the plaintext and forgets the token', async () => {
    const { registry, dataPath } = mk();
    const staged = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });
    expect(scratchFiles(dataPath)).toHaveLength(1);

    await registry.dispose(staged.token);

    expect(scratchFiles(dataPath)).toHaveLength(0);
    expect(registry.size()).toBe(0);
    await expect(registry.read(staged.token, 0, 4))
      .rejects.toThrow(/unknown or disposed staging token/);
  });

  it('⚠ drops the entry BEFORE awaiting the unlink', async () => {
    // The ordering is the property, and it is invisible to any assertion made
    // after `dispose` resolves. `registry.dispose` is called WITHOUT await, so
    // the read lands in the exact window: if the delete happened after
    // `handle.dispose()`, the read would be handed a handle whose file is on
    // its way out and would return bytes (or a confusing fs error) instead of
    // the honest refusal.
    const { registry } = mk();
    const staged = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });

    const disposing = registry.dispose(staged.token);
    await expect(registry.read(staged.token, 0, 4))
      .rejects.toThrow(/unknown or disposed staging token/);
    await disposing;
  });

  it('is idempotent — a second dispose is a no-op, not a throw', async () => {
    // `dispose` lives in a `finally`; a throwing second call would mask the
    // real error that sent us there.
    const { registry } = mk();
    const staged = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });
    await registry.dispose(staged.token);
    await expect(registry.dispose(staged.token)).resolves.toBeUndefined();
    await expect(registry.dispose('never-existed')).resolves.toBeUndefined();
  });

  it('disposeAll clears every entry and every scratch file', async () => {
    const { registry, dataPath } = mk();
    await registry.stage({ file_ref: 'f1', max_bytes: 1024 });
    await registry.stage({ file_ref: 'f2', max_bytes: 1024 });
    expect(registry.size()).toBe(2);
    expect(scratchFiles(dataPath)).toHaveLength(2);

    await registry.disposeAll();

    expect(registry.size()).toBe(0);
    expect(scratchFiles(dataPath)).toHaveLength(0);
  });
});

describe('D-217 registry — a failed stage mints nothing and leaks nothing', () => {
  it('a content-pin mismatch leaves no token, no entry, and no plaintext', async () => {
    // § 8c fail-closed only means anything if this happens BEFORE the walk can
    // address the file — a swapped CAS carrier caught after the first APPEND
    // is a swapped carrier already sent.
    const { registry, dataPath } = mk();
    await expect(registry.stage({
      file_ref: 'f1',
      expect_sha256: 'b'.repeat(64),
      max_bytes: 1024,
    })).rejects.toThrow(/content pin mismatch/);

    expect(registry.size()).toBe(0);
    expect(scratchFiles(dataPath)).toHaveLength(0);
  });

  it('a matching content pin stages normally', async () => {
    // The inverse, so the pin test above cannot pass by refusing everything.
    const { registry } = mk();
    const staged = await registry.stage({
      file_ref: 'f1',
      expect_sha256: CONTENT_SHA,
      max_bytes: 1024,
    });
    expect(staged.size_bytes).toBe(CONTENT.length);
    await registry.dispose(staged.token);
  });

  it('an over-cap file is refused with no entry and no disk spent', async () => {
    const { registry, dataPath } = mk();
    await expect(registry.stage({ file_ref: 'f1', max_bytes: 4 }))
      .rejects.toThrow(/over the 4-byte cap/);
    expect(registry.size()).toBe(0);
    expect(scratchFiles(dataPath)).toHaveLength(0);
  });

  it('refuses an unknown file_ref', async () => {
    const { registry } = mk();
    await expect(registry.stage({ file_ref: 'missing', max_bytes: 1024 }))
      .rejects.toThrow(/unknown file_ref/);
    expect(registry.size()).toBe(0);
  });

  it('refuses a mirrored provider file — there is no local plaintext to stage', async () => {
    const { registry } = mk();
    await expect(registry.stage({ file_ref: 'remote', max_bytes: 1024 }))
      .rejects.toThrow(/not a CAS blob/);
    expect(registry.size()).toBe(0);
  });
});

describe('D-217 registry — concurrent staging is bounded', () => {
  it(`refuses the (${MAX_CONCURRENT_STAGED} + 1)th stage`, async () => {
    const { registry, dataPath } = mk();
    for (let i = 0; i < MAX_CONCURRENT_STAGED; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await registry.stage({ file_ref: `f${i}`, max_bytes: 1024 });
    }
    await expect(registry.stage({ file_ref: 'one-too-many', max_bytes: 1024 }))
      .rejects.toThrow(/refusing to stage another/);
    // Refused BEFORE any disk was spent on it.
    expect(scratchFiles(dataPath)).toHaveLength(MAX_CONCURRENT_STAGED);
    await registry.disposeAll();
  });

  it('a disposed slot is reusable — the cap is concurrency, not a lifetime quota', async () => {
    const { registry } = mk();
    const staged: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_STAGED; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      staged.push((await registry.stage({ file_ref: `f${i}`, max_bytes: 1024 })).token);
    }
    await registry.dispose(staged[0]!);
    const reused = await registry.stage({ file_ref: 'after-release', max_bytes: 1024 });
    expect(reused.token).toBeTruthy();
    await registry.disposeAll();
  });
});

describe('D-217 registry — the scratch file is the sweep\'s to reap', () => {
  it('stages under the prefix the boot sweep knows', async () => {
    // The coupling slice 0 called the sharp edge: a writer that mints its own
    // path is invisible to `sweepBlobScratch` and strands plaintext forever.
    const { registry, dataPath } = mk();
    const staged = await registry.stage({ file_ref: 'f1', max_bytes: 1024 });
    const [name] = scratchFiles(dataPath);
    expect(name).toBeDefined();
    expect(existsSync(join(dataPath, name!))).toBe(true);
    // And the name discloses nothing about WHICH warehouse object is leaving.
    expect(name!).not.toContain('a'.repeat(64));
    await registry.dispose(staged.token);
  });
});
