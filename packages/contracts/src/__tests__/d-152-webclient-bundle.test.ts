/** D-152 § A.16 — webclient bundle substrate (contracts).
 *
 *  Tests the closed-list constants + `verifyWebclientBundle` validator
 *  that the server-side handler factory (`backend/server/`) and the
 *  path-router's `/webclient/*` carve-out depend on. */

import { describe, expect, it } from 'vitest';
import {
  WEBCLIENT_PATH_PREFIX,
  WEBCLIENT_BUNDLE_VERIFY_ERROR_CODES,
  WEBCLIENT_BUNDLE_PATH_REGEX,
  WEBCLIENT_BUNDLE_SHA256_REGEX,
  verifyWebclientBundle,
  type WebclientBundleFile,
  type WebclientBundleManifest,
} from '../webclient-bundle.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

const file = (path: string, sha256: string, bytes = new Uint8Array([1])): WebclientBundleFile => ({
  path,
  sha256,
  bytes,
});

describe('D-152 § A.16 — closed-list constants', () => {
  it('WEBCLIENT_PATH_PREFIX is `/webclient`', () => {
    expect(WEBCLIENT_PATH_PREFIX).toBe('/webclient');
  });

  it('WEBCLIENT_BUNDLE_VERIFY_ERROR_CODES is 8 entries (closed list)', () => {
    expect(WEBCLIENT_BUNDLE_VERIFY_ERROR_CODES.length).toBe(8);
    expect(WEBCLIENT_BUNDLE_VERIFY_ERROR_CODES).toEqual([
      'manifest_empty',
      'manifest_path_invalid',
      'manifest_sha256_malformed',
      'manifest_path_duplicate',
      'bundle_path_invalid',
      'bundle_sha256_mismatch',
      'bundle_missing_manifest_entry',
      'bundle_extra_file',
    ]);
  });
});

describe('D-152 § A.16 — WEBCLIENT_BUNDLE_PATH_REGEX', () => {
  it.each([
    'index.html',
    'manifest.json',
    'sw.js',
    'assets/main-abc123.js',
    'assets/styles/index.css',
    'icons/icon-192.png',
    'fonts/inter-roman.woff2',
    'a/b/c/d/e.txt',
  ])('accepts %s (canonical bundle path)', (path) => {
    expect(WEBCLIENT_BUNDLE_PATH_REGEX.test(path)).toBe(true);
  });

  it.each([
    '/index.html',                       // leading slash
    '../etc/passwd',                     // path traversal
    'assets/../etc/passwd',              // embedded path traversal
    'assets//double-slash.js',           // double slash
    'assets/main.js\0evil',              // null byte
    'assets\\windows-sep.js',            // backslash
    'asset with spaces.js',              // whitespace
    'asset(with-parens).js',             // parens
    'asset?query=evil',                  // query in filename
    'asset#fragment',                    // fragment in filename
    'café.html',                         // non-ascii
    '',                                  // empty
  ])('rejects %s (unsafe / unsupported)', (path) => {
    expect(WEBCLIENT_BUNDLE_PATH_REGEX.test(path)).toBe(false);
  });
});

describe('D-152 § A.16 — WEBCLIENT_BUNDLE_SHA256_REGEX', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(WEBCLIENT_BUNDLE_SHA256_REGEX.test(HASH_A)).toBe(true);
    expect(WEBCLIENT_BUNDLE_SHA256_REGEX.test('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it.each([
    'A'.repeat(64),                       // uppercase
    'a'.repeat(63),                       // too short
    'a'.repeat(65),                       // too long
    'g'.repeat(64),                       // non-hex letter
    'sha256:' + 'a'.repeat(64),           // prefixed
    '',                                   // empty
  ])('rejects %s', (input) => {
    expect(WEBCLIENT_BUNDLE_SHA256_REGEX.test(input)).toBe(false);
  });
});

describe('D-152 § A.16 — verifyWebclientBundle (happy path)', () => {
  it('returns ok=true when manifest and bundle match exactly', () => {
    const manifest: WebclientBundleManifest = {
      files: [
        { path: 'index.html', sha256: HASH_A },
        { path: 'sw.js', sha256: HASH_B },
      ],
    };
    const bundle = [file('index.html', HASH_A), file('sw.js', HASH_B)];
    expect(verifyWebclientBundle(manifest, bundle)).toEqual({ ok: true });
  });

  it('order-insensitive on both manifest and bundle', () => {
    const manifest: WebclientBundleManifest = {
      files: [
        { path: 'sw.js', sha256: HASH_B },
        { path: 'index.html', sha256: HASH_A },
      ],
    };
    const bundle = [file('index.html', HASH_A), file('sw.js', HASH_B)];
    expect(verifyWebclientBundle(manifest, bundle)).toEqual({ ok: true });
  });
});

describe('D-152 § A.16 — verifyWebclientBundle (manifest validation)', () => {
  it('rejects empty manifest with manifest_empty', () => {
    const result = verifyWebclientBundle({ files: [] }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ code: 'manifest_empty' }]);
    }
  });

  it('rejects manifest entry with unsafe path', () => {
    const manifest: WebclientBundleManifest = {
      files: [{ path: '../etc/passwd', sha256: HASH_A }],
    };
    const result = verifyWebclientBundle(manifest, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { code: 'manifest_path_invalid', path: '../etc/passwd' },
      ]);
    }
  });

  it('rejects manifest entry with malformed sha256', () => {
    const manifest: WebclientBundleManifest = {
      files: [{ path: 'index.html', sha256: 'not-a-hash' }],
    };
    const result = verifyWebclientBundle(manifest, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toEqual({
        code: 'manifest_sha256_malformed',
        path: 'index.html',
      });
    }
  });

  it('rejects manifest with duplicate path entries', () => {
    const manifest: WebclientBundleManifest = {
      files: [
        { path: 'index.html', sha256: HASH_A },
        { path: 'index.html', sha256: HASH_B },
      ],
    };
    const result = verifyWebclientBundle(manifest, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'manifest_path_duplicate')).toBe(true);
    }
  });
});

describe('D-152 § A.16 — verifyWebclientBundle (bundle validation)', () => {
  it('rejects bundle with sha256 mismatch (preserves expected + actual for diagnosis)', () => {
    const manifest: WebclientBundleManifest = {
      files: [{ path: 'index.html', sha256: HASH_A }],
    };
    const bundle = [file('index.html', HASH_C)];
    const result = verifyWebclientBundle(manifest, bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          code: 'bundle_sha256_mismatch',
          path: 'index.html',
          expected_sha256: HASH_A,
          actual_sha256: HASH_C,
        },
      ]);
    }
  });

  it('rejects bundle with file not in manifest (bundle_extra_file)', () => {
    const manifest: WebclientBundleManifest = {
      files: [{ path: 'index.html', sha256: HASH_A }],
    };
    const bundle = [file('index.html', HASH_A), file('extra.js', HASH_B)];
    const result = verifyWebclientBundle(manifest, bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ code: 'bundle_extra_file', path: 'extra.js' }]);
    }
  });

  it('rejects when manifest entry is missing from bundle (bundle_missing_manifest_entry)', () => {
    const manifest: WebclientBundleManifest = {
      files: [
        { path: 'index.html', sha256: HASH_A },
        { path: 'sw.js', sha256: HASH_B },
      ],
    };
    const bundle = [file('index.html', HASH_A)];
    const result = verifyWebclientBundle(manifest, bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { code: 'bundle_missing_manifest_entry', path: 'sw.js' },
      ]);
    }
  });

  it('rejects bundle file with unsafe path (defense-in-depth — caller should also pre-validate)', () => {
    const manifest: WebclientBundleManifest = {
      files: [{ path: 'index.html', sha256: HASH_A }],
    };
    const bundle = [file('../escape.html', HASH_A)];
    const result = verifyWebclientBundle(manifest, bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'bundle_path_invalid')).toBe(true);
    }
  });

  it('accumulates multiple issues across the bundle (does not short-circuit on first miss)', () => {
    const manifest: WebclientBundleManifest = {
      files: [
        { path: 'index.html', sha256: HASH_A },
        { path: 'sw.js', sha256: HASH_B },
      ],
    };
    const bundle = [
      file('index.html', HASH_C),       // hash mismatch
      file('manifest.json', HASH_A),    // extra file
                                        // sw.js missing
    ];
    const result = verifyWebclientBundle(manifest, bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code).sort();
      expect(codes).toEqual([
        'bundle_extra_file',
        'bundle_missing_manifest_entry',
        'bundle_sha256_mismatch',
      ]);
    }
  });
});

describe('D-152 § A.16 — fingerprint discipline', () => {
  it('manifest-empty does NOT depend on the bundle (early return)', () => {
    // Important: an attacker who supplies an arbitrary bundle to a
    // server with an empty manifest should NOT see "everything matches"
    // — the verifier rejects on the manifest shape before looking at
    // the bundle.
    const bundle = [file('index.html', HASH_A), file('sw.js', HASH_B)];
    const result = verifyWebclientBundle({ files: [] }, bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ code: 'manifest_empty' }]);
    }
  });
});
