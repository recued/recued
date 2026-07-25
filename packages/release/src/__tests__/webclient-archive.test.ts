/** D-178 + D-152 § A.16 — webclient bundle archive pack/unpack. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  isSafeWebclientPath,
  packWebclientArchive,
  unpackWebclientArchive,
  WEBCLIENT_ARCHIVE_SCHEMA,
  webclientArchiveFileName,
  webclientArtifactTrustedComment,
} from '../webclient-archive.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const sampleFiles = [
  { path: 'webclient-bundle-manifest.json', bytes: bytes('{"files":[{"path":"index.html","sha256":"x"}]}') },
  { path: 'index.html', bytes: bytes('<!doctype html><title>recued</title>') },
  { path: 'assets/app.js', bytes: bytes('console.log(1)') },
];

describe('webclientArchiveFileName + trusted comment', () => {
  it('names the archive by version + binds file name & version', () => {
    expect(webclientArchiveFileName('1.4.2')).toBe('webclient-1.4.2.bundle.json');
    expect(webclientArtifactTrustedComment('webclient-1.4.2.bundle.json', '1.4.2')).toBe(
      'recued webclient webclient-1.4.2.bundle.json v1.4.2',
    );
  });
});

describe('isSafeWebclientPath', () => {
  it('accepts plain relative paths incl. subdirs + dotted names', () => {
    for (const p of ['index.html', 'assets/app.js', 'oauth-callback-relay.js.map', 'a/b/c.css']) {
      expect(isSafeWebclientPath(p)).toBe(true);
    }
  });
  it('rejects traversal / absolute / backslash / empty segments', () => {
    for (const p of ['', '/etc/passwd', '../secret', 'a/../b', 'a/./b', 'a//b', 'a\\b', './x', 'foo/..']) {
      expect(isSafeWebclientPath(p)).toBe(false);
    }
  });
});

describe('packWebclientArchive', () => {
  it('round-trips to the same file set (unpack recovers exact bytes)', () => {
    const text = packWebclientArchive({ version: '1.0.0', files: sampleFiles });
    const out = unpackWebclientArchive(text);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.version).toBe('1.0.0');
    const byPath = new Map(out.files.map((f) => [f.path, Buffer.from(f.bytes).toString()]));
    for (const f of sampleFiles) expect(byPath.get(f.path)).toBe(Buffer.from(f.bytes).toString());
  });

  it('is deterministic (sorted, stable) — same inputs → byte-identical output', () => {
    const a = packWebclientArchive({ version: '2.0.0', files: sampleFiles });
    const shuffled = [...sampleFiles].reverse();
    const b = packWebclientArchive({ version: '2.0.0', files: shuffled });
    expect(a).toBe(b);
    // sorted by path inside the doc
    const doc = JSON.parse(a) as { schema: number; files: Array<{ path: string }> };
    expect(doc.schema).toBe(WEBCLIENT_ARCHIVE_SCHEMA);
    expect(doc.files.map((f) => f.path)).toEqual(['assets/app.js', 'index.html', 'webclient-bundle-manifest.json']);
  });

  it('carries a real sha256 per file', () => {
    const doc = JSON.parse(packWebclientArchive({ version: '1.0.0', files: sampleFiles })) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const entry = doc.files.find((f) => f.path === 'index.html')!;
    expect(entry.sha256).toBe(sha(sampleFiles[1]!.bytes));
  });

  it('throws on an unsafe path, a duplicate, an empty set, or an empty version', () => {
    expect(() => packWebclientArchive({ version: '1', files: [{ path: '../x', bytes: bytes('a') }] })).toThrow(/unsafe/);
    expect(() =>
      packWebclientArchive({ version: '1', files: [{ path: 'a', bytes: bytes('1') }, { path: 'a', bytes: bytes('2') }] }),
    ).toThrow(/duplicate/);
    expect(() => packWebclientArchive({ version: '1', files: [] })).toThrow(/at least one/);
    expect(() => packWebclientArchive({ version: '', files: sampleFiles })).toThrow(/version/);
  });
});

describe('unpackWebclientArchive — fail-closed', () => {
  const good = packWebclientArchive({ version: '1.0.0', files: sampleFiles });

  it('rejects invalid JSON / non-object / array root', () => {
    expect(unpackWebclientArchive('not json')).toMatchObject({ ok: false, reason: 'invalid_json' });
    expect(unpackWebclientArchive('42')).toMatchObject({ ok: false, reason: 'not_object' });
    expect(unpackWebclientArchive('[]')).toMatchObject({ ok: false, reason: 'not_object' });
  });

  it('rejects an unsupported schema / missing version / missing or empty files', () => {
    expect(unpackWebclientArchive(JSON.stringify({ schema: 99, version: '1', files: [] }))).toMatchObject({
      ok: false,
      reason: 'unsupported_schema',
    });
    expect(unpackWebclientArchive(JSON.stringify({ schema: 1, files: [] }))).toMatchObject({ ok: false, reason: 'missing_version' });
    expect(unpackWebclientArchive(JSON.stringify({ schema: 1, version: '1' }))).toMatchObject({ ok: false, reason: 'missing_files' });
    expect(unpackWebclientArchive(JSON.stringify({ schema: 1, version: '1', files: [] }))).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects a file whose bytes do not match its declared sha256 (tamper)', () => {
    const doc = JSON.parse(good) as { files: Array<{ path: string; base64: string }> };
    const i = doc.files.findIndex((f) => f.path === 'index.html');
    doc.files[i]!.base64 = Buffer.from('<hacked/>').toString('base64'); // sha256 unchanged
    expect(unpackWebclientArchive(JSON.stringify(doc))).toMatchObject({ ok: false, reason: 'sha256_mismatch:index.html' });
  });

  it('rejects an unsafe path or a duplicate path in the archive', () => {
    const mk = (files: unknown[]): string => JSON.stringify({ schema: 1, version: '1', files });
    expect(
      unpackWebclientArchive(mk([{ path: '../evil', sha256: sha(bytes('x')), base64: Buffer.from('x').toString('base64') }])),
    ).toMatchObject({ ok: false, reason: 'unsafe_path:../evil' });
    const dup = { path: 'a', sha256: sha(bytes('x')), base64: Buffer.from('x').toString('base64') };
    expect(unpackWebclientArchive(mk([dup, dup]))).toMatchObject({ ok: false, reason: 'duplicate_path:a' });
  });

  it('rejects a malformed entry (missing sha256/base64)', () => {
    expect(unpackWebclientArchive(JSON.stringify({ schema: 1, version: '1', files: [{ path: 'a' }] }))).toMatchObject({
      ok: false,
      reason: 'malformed_entry:a',
    });
  });
});
