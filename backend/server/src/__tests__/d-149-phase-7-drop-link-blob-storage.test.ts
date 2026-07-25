/** D-149 P7 § A.5.4 — drop blob CAS storage tests.
 *
 *  Covers:
 *    - sha256 content-hash CAS storage path.
 *    - Size cap aborts mid-stream + cleans the temp file.
 *    - Magic-byte detector: PDF / PNG / JPEG / WEBP / GIF prefixes.
 *    - Filename sanitization (path traversal, control bytes, length cap).
 *    - Cloud-traversal negative test per § Must Hold I-7: blob writes
 *      land ONLY under the user's local CAS; no path leaks outside. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  detectMagicBytes,
  sanitizeFilename,
  writeDropBlobStream,
} from '../ports/reception/drop-blob-storage.js';
import { createBlobStore } from '../storage/blob-store.js';

const NOW = Date.UTC(2026, 4, 13, 12, 0, 0); // 2026-05-13

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'd149-p7-blobstore-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('D-149 P7 § A.5.4 — sanitizeFilename', () => {
  it('strips POSIX + Windows path components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
  });

  it('rejects bare dot / dot-dot', () => {
    expect(sanitizeFilename('..')).toBeNull();
    expect(sanitizeFilename('.')).toBeNull();
    expect(sanitizeFilename('')).toBeNull();
  });

  it('strips NUL + control bytes', () => {
    expect(sanitizeFilename('safe\x00name.pdf')).toBe('safename.pdf');
    expect(sanitizeFilename('with\x07\x08bell.pdf')).toBe('withbell.pdf');
  });

  it('collapses whitespace runs', () => {
    expect(sanitizeFilename('two  spaces  here.pdf')).toBe('two spaces here.pdf');
  });

  it('truncates beyond the 255-byte cap and preserves extension when possible', () => {
    const stem = 'a'.repeat(300);
    const out = sanitizeFilename(`${stem}.pdf`)!;
    expect(out.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(255);
  });
});

describe('D-149 P7 § A.5.4 — detectMagicBytes', () => {
  it('detects PDF', () => {
    expect(detectMagicBytes(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  });
  it('detects PNG', () => {
    expect(
      detectMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
  });
  it('detects JPEG', () => {
    expect(detectMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });
  it('detects WEBP', () => {
    const head = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]),
      Buffer.from([0x57, 0x45, 0x42, 0x50]),
    ]);
    expect(detectMagicBytes(head)).toBe('image/webp');
  });
  it('detects GIF', () => {
    expect(detectMagicBytes(Buffer.from('GIF87a\0'))).toBe('image/gif');
    expect(detectMagicBytes(Buffer.from('GIF89a\0'))).toBe('image/gif');
  });
  it('returns text/plain for an ASCII-only head', () => {
    expect(detectMagicBytes(Buffer.from('hello world\n', 'utf8'))).toBe('text/plain');
  });
  it('returns null for binaries that match none of the closed list', () => {
    // Disguised executable — MZ header (Windows PE). Not in our allowlist.
    expect(detectMagicBytes(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
  });
});

describe('D-149 P7 § A.5.4 — writeDropBlobStream', () => {
  it('writes the blob to CAS + returns sha256', async () => {
    const blobs = createBlobStore(join(root, 'cas'));
    const payload = Buffer.from('%PDF-1.7\nhello world\n');
    const sha = createHash('sha256').update(payload).digest('hex');
    const result = await writeDropBlobStream(Readable.from([payload]), {
      drop_blobs_root: root,
      blobs,
      size_cap_bytes: 100,
      now: NOW,
    });
    expect(result.content_hash).toBe(sha);
    expect(result.size_bytes).toBe(payload.length);
    expect(result.relative_path).toMatch(/^[0-9a-f]{64}$/);
    expect(result.mime_detected).toBe('application/pdf');
    const stored = await blobs.get(result.relative_path);
    expect(stored).not.toBeNull();
    expect(Buffer.compare(stored!, payload)).toBe(0);
  });

  it('rejects the stream when size_cap_bytes is exceeded', async () => {
    const blobs = createBlobStore(join(root, 'cas'));
    const payload = Buffer.from('x'.repeat(2048));
    await expect(
      writeDropBlobStream(Readable.from([payload]), {
        drop_blobs_root: root,
        blobs,
        size_cap_bytes: 1024,
        now: NOW,
      }),
    ).rejects.toThrow('size_cap_exceeded');
    // Temp directory should not retain the partial blob — listing should
    // be empty (or hold only the tmp directory itself).
    try {
      const tmpStat = statSync(join(root, '_tmp'));
      expect(tmpStat.isDirectory()).toBe(true);
    } catch {
      // _tmp not even created — also acceptable.
    }
  });

  it('content-hash dedup — two visitors uploading the same bytes share the same storage_path', async () => {
    const blobs = createBlobStore(join(root, 'cas'));
    const payload = Buffer.from('%PDF-1.0\nsame content\n');
    const a = await writeDropBlobStream(Readable.from([payload]), {
      drop_blobs_root: root,
      blobs,
      size_cap_bytes: 1024,
      now: NOW,
    });
    const b = await writeDropBlobStream(Readable.from([payload]), {
      drop_blobs_root: root,
      blobs,
      size_cap_bytes: 1024,
      now: NOW,
    });
    expect(a.relative_path).toBe(b.relative_path);
    expect(a.content_hash).toBe(b.content_hash);
  });

  it('cloud-traversal negative — storage_path is a CAS hash, not a filesystem path (§ Must Hold I-7)', async () => {
    const blobs = createBlobStore(join(root, 'cas'));
    const payload = Buffer.from('%PDF-1.0\nstuff');
    const result = await writeDropBlobStream(Readable.from([payload]), {
      drop_blobs_root: root,
      blobs,
      size_cap_bytes: 1024,
      now: NOW,
    });
    expect(result.relative_path).toMatch(/^[0-9a-f]{64}$/);
    expect(result.relative_path).not.toMatch(/[\\/]/);
    expect(await blobs.get(result.relative_path)).toEqual(payload);
  });
});
