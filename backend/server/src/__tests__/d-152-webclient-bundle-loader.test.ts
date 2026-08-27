/** D-152 § A.16 — webclient bundle disk-loader tests.
 *
 *  Tests `loadWebclientBundleFromDisk` in
 *  `backend/server/src/webclient-bundle-loader.ts` — the production wiring
 *  that reads the dropped-in bundle from disk at server boot. Real temp-dir
 *  fixtures (the loader is I/O-centric; mocking fs would test nothing). The
 *  loader's contract:
 *
 *   - returns `null` for the benign "nothing to mount" cases (no directory,
 *     no manifest) — `/webclient/*` simply stays unmounted;
 *   - throws `WebclientBundleLoadError` when the manifest IS present but
 *     untrusted (unreadable / malformed JSON / wrong shape);
 *   - is manifest-DRIVEN: reads exactly the files the manifest lists, ignores
 *     strays, and re-hashes each from disk so the downstream
 *     `verifyWebclientBundle` (the same gate the production wiring runs)
 *     catches a corrupt or missing file.
 *
 *  The final block mirrors the production wiring's load→verify decision end
 *  to end (`compose-listeners.ts`): a clean bundle verifies, a tampered or
 *  partial one fails. */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  verifyWebclientBundle,
  WEBCLIENT_BUNDLE_MANIFEST_FILENAME,
  type WebclientBundleManifest,
} from '@recued/contracts';
import {
  isVerifiedWebclientBundlePresent,
  loadWebclientBundleFromDisk,
  resolveInstalledWebclientDir,
  resolveServedWebclientBundleDir,
  resolveSourceTreeWebclientDir,
  resolveWebclientBundleDir,
  WebclientBundleLoadError,
} from '../webclient-bundle-loader.js';

const sha256Hex = (s: string): string =>
  createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** `backend/server/src/__tests__/` → the repo root. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recued-webclient-bundle-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a file (creating parent dirs) under the fixture dir. */
const put = (rel: string, content: string): void => {
  const abs = join(dir, rel);
  const slash = rel.lastIndexOf('/');
  if (slash >= 0) mkdirSync(join(dir, rel.slice(0, slash)), { recursive: true });
  writeFileSync(abs, content, 'utf8');
};

/** Write the integrity manifest (the loader's entry point). */
const putManifest = (manifest: WebclientBundleManifest): void =>
  writeFileSync(
    join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME),
    JSON.stringify(manifest),
    'utf8',
  );

/** A standard 3-file bundle on disk + the matching manifest. */
const seedValidBundle = (): WebclientBundleManifest => {
  const index = '<html><body>webclient</body></html>';
  const main = 'export const x = 1;';
  const icon = 'PNGDATA';
  put('index.html', index);
  put('assets/main.js', main);
  put('assets/icon.png', icon);
  const manifest: WebclientBundleManifest = {
    files: [
      { path: 'index.html', sha256: sha256Hex(index) },
      { path: 'assets/main.js', sha256: sha256Hex(main) },
      { path: 'assets/icon.png', sha256: sha256Hex(icon) },
    ],
  };
  putManifest(manifest);
  return manifest;
};

describe('D-152 § A.16 — loadWebclientBundleFromDisk: absent ⇒ null (dormant)', () => {
  it('returns null when the directory does not exist', async () => {
    expect(await loadWebclientBundleFromDisk(join(dir, 'does-not-exist'))).toBeNull();
  });

  it('returns null when the directory exists but has no manifest', async () => {
    put('index.html', '<html></html>');
    put('assets/main.js', 'export const x = 1;');
    expect(await loadWebclientBundleFromDisk(dir)).toBeNull();
  });
});

describe('D-152 § A.16 — loadWebclientBundleFromDisk: present-but-untrusted ⇒ throws', () => {
  it('throws manifest_malformed_json on non-JSON manifest', async () => {
    seedValidBundle();
    writeFileSync(join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME), 'not json {', 'utf8');
    await expect(loadWebclientBundleFromDisk(dir)).rejects.toMatchObject({
      name: 'WebclientBundleLoadError',
      reason: 'manifest_malformed_json',
    });
  });

  it('throws manifest_invalid_shape when JSON parses but is the wrong shape', async () => {
    writeFileSync(
      join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME),
      JSON.stringify({ files: 'not-an-array' }),
      'utf8',
    );
    await expect(loadWebclientBundleFromDisk(dir)).rejects.toMatchObject({
      reason: 'manifest_invalid_shape',
    });
  });

  it('throws manifest_invalid_shape when an entry is missing sha256', async () => {
    writeFileSync(
      join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME),
      JSON.stringify({ files: [{ path: 'index.html' }] }),
      'utf8',
    );
    await expect(loadWebclientBundleFromDisk(dir)).rejects.toBeInstanceOf(
      WebclientBundleLoadError,
    );
  });

  it('throws manifest_unreadable when the manifest path is not a regular file (EISDIR)', async () => {
    // A directory named like the manifest ⇒ readFile fails with a non-ENOENT
    // code ⇒ "present but unreadable", which must NOT degrade to the benign
    // null path.
    mkdirSync(join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME));
    await expect(loadWebclientBundleFromDisk(dir)).rejects.toMatchObject({
      reason: 'manifest_unreadable',
    });
  });
});

describe('D-152 § A.16 — loadWebclientBundleFromDisk: manifest-driven read', () => {
  it('loads exactly the listed files, with disk-computed hashes, and verifies clean', async () => {
    const manifest = seedValidBundle();
    const loaded = await loadWebclientBundleFromDisk(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.files.map((f) => f.path).sort()).toEqual([
      'assets/icon.png',
      'assets/main.js',
      'index.html',
    ]);
    // Each returned file carries the real hash of its bytes.
    for (const f of loaded!.files) {
      expect(f.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'));
    }
    // The exact gate the production wiring runs.
    expect(verifyWebclientBundle(manifest, loaded!.files).ok).toBe(true);
  });

  it('excludes the manifest file itself from the served files', async () => {
    seedValidBundle();
    const loaded = await loadWebclientBundleFromDisk(dir);
    expect(loaded!.files.some((f) => f.path === WEBCLIENT_BUNDLE_MANIFEST_FILENAME)).toBe(
      false,
    );
  });

  it('ignores stray on-disk files not named in the manifest', async () => {
    const manifest = seedValidBundle();
    // A stray that would trip the handler one-to-one check if naively included.
    put('.DS_Store', 'junk');
    put('leftover.tmp', 'old');
    const loaded = await loadWebclientBundleFromDisk(dir);
    expect(loaded!.files.some((f) => f.path === '.DS_Store')).toBe(false);
    expect(loaded!.files.some((f) => f.path === 'leftover.tmp')).toBe(false);
    expect(verifyWebclientBundle(manifest, loaded!.files).ok).toBe(true);
  });
});

describe('D-152 § A.16 — load→verify decision (mirrors the production wiring)', () => {
  it('a corrupt-on-disk file ⇒ loads but fails verification (bundle_sha256_mismatch)', async () => {
    const manifest = seedValidBundle();
    // Rewrite a listed file AFTER the manifest was generated.
    writeFileSync(join(dir, 'assets/main.js'), 'export const x = 999; // tampered', 'utf8');
    const loaded = await loadWebclientBundleFromDisk(dir);
    expect(loaded).not.toBeNull();
    const verified = verifyWebclientBundle(manifest, loaded!.files);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.issues.map((i) => i.code)).toContain('bundle_sha256_mismatch');
    }
  });

  it('a manifest entry with a traversal path is never read off-disk; verification rejects it', async () => {
    // Seed a clean bundle, then point a manifest entry OUTSIDE the dir. The
    // loader must not read the traversed file into the served set.
    seedValidBundle();
    const escapeTarget = join(dir, '..', 'secret-outside-bundle.txt');
    writeFileSync(escapeTarget, 'TOP SECRET', 'utf8');
    try {
      const poisoned: WebclientBundleManifest = {
        files: [
          { path: 'index.html', sha256: sha256Hex('<html><body>webclient</body></html>') },
          { path: '../secret-outside-bundle.txt', sha256: sha256Hex('TOP SECRET') },
        ],
      };
      putManifest(poisoned);
      const loaded = await loadWebclientBundleFromDisk(dir);
      // The traversal entry was skipped — its bytes never entered the bundle.
      expect(loaded!.files.some((f) => f.path === '../secret-outside-bundle.txt')).toBe(
        false,
      );
      expect(
        loaded!.files.some((f) => new TextDecoder().decode(f.bytes) === 'TOP SECRET'),
      ).toBe(false);
      // And the bundle as a whole fails verification (invalid manifest path).
      expect(verifyWebclientBundle(poisoned, loaded!.files).ok).toBe(false);
    } finally {
      rmSync(escapeTarget, { force: true });
    }
  });

  it('a manifest entry that is a symlink escaping the bundle dir is not followed', async () => {
    // The path STRING `assets/main.js` passes the regex, but on disk it is a
    // symlink to a secret OUTSIDE the bundle. The loader must not read the
    // target into the served set (the regex alone wouldn't catch this).
    const manifest = seedValidBundle();
    const secret = join(dir, '..', 'recued-symlink-secret.txt');
    writeFileSync(secret, 'PRIVATE KEY MATERIAL', 'utf8');
    try {
      rmSync(join(dir, 'assets/main.js'));
      symlinkSync(secret, join(dir, 'assets/main.js'));
      const loaded = await loadWebclientBundleFromDisk(dir);
      // The escaping entry was skipped — secret bytes never entered the bundle.
      expect(loaded!.files.some((f) => f.path === 'assets/main.js')).toBe(false);
      expect(
        loaded!.files.some(
          (f) => new TextDecoder().decode(f.bytes) === 'PRIVATE KEY MATERIAL',
        ),
      ).toBe(false);
      // Bundle as a whole fails verification (the listed file is now missing).
      expect(verifyWebclientBundle(manifest, loaded!.files).ok).toBe(false);
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it('a manifest-listed file missing on disk ⇒ dropped, fails verification (bundle_missing_manifest_entry)', async () => {
    const manifest = seedValidBundle();
    rmSync(join(dir, 'assets/icon.png'));
    const loaded = await loadWebclientBundleFromDisk(dir);
    expect(loaded!.files.some((f) => f.path === 'assets/icon.png')).toBe(false);
    const verified = verifyWebclientBundle(manifest, loaded!.files);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.issues.map((i) => i.code)).toContain('bundle_missing_manifest_entry');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// R26.2 Delta 3 — apex servability probe + dir resolver
// ────────────────────────────────────────────────────────────────

describe('R26.2 Delta 3 — isVerifiedWebclientBundlePresent (apex servability probe)', () => {
  it('true for a clean verified bundle (the same predicate the serving path applies)', async () => {
    seedValidBundle();
    expect(await isVerifiedWebclientBundlePresent(dir)).toBe(true);
  });

  it('false when nothing is deployed (no dir / no manifest) — never throws', async () => {
    expect(await isVerifiedWebclientBundlePresent(join(dir, 'does-not-exist'))).toBe(false);
    expect(await isVerifiedWebclientBundlePresent(dir)).toBe(false); // empty dir, no manifest
  });

  it('false on a present-but-untrusted manifest (loader throws → caught)', async () => {
    seedValidBundle();
    writeFileSync(join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME), 'not json {', 'utf8');
    expect(await isVerifiedWebclientBundlePresent(dir)).toBe(false);
  });

  it('false on a corrupt-on-disk file (verify fails → not servable, mirrors compose-listeners)', async () => {
    seedValidBundle();
    writeFileSync(join(dir, 'assets/main.js'), 'export const x = 999; // tampered', 'utf8');
    expect(await isVerifiedWebclientBundlePresent(dir)).toBe(false);
  });
});

describe('R26.2 Delta 3 — resolveWebclientBundleDir', () => {
  it('the RECUED_WEBCLIENT_DIR override wins (trimmed)', () => {
    expect(resolveWebclientBundleDir('/data/cas/blobs', '  /custom/webclient  ')).toBe('/custom/webclient');
  });

  it('falls back to a `webclient` sibling of the CAS blob root', () => {
    const root = '/var/lib/recued/cas/blobs';
    expect(resolveWebclientBundleDir(root, undefined)).toBe(join(dirname(root), 'webclient'));
  });

  it('an empty / whitespace override falls back to the CAS sibling', () => {
    const root = '/var/lib/recued/cas/blobs';
    expect(resolveWebclientBundleDir(root, '   ')).toBe(join(dirname(root), 'webclient'));
  });

  it('undefined when neither override nor CAS root is available (dbless boot)', () => {
    expect(resolveWebclientBundleDir(undefined, undefined)).toBeUndefined();
    expect(resolveWebclientBundleDir(undefined, '')).toBeUndefined();
  });
});

// ── Dev serve flow — resolveServedWebclientBundleDir ───────────────────────
//
// The serving path adds a source-checkout tier so `tsx backend/server/src/bin.ts
// serve` in a clone serves `apps/webclient/build` with no env var. The rule that
// makes that safe on a real install is precedence: a deployment dir that HOLDS a
// bundle always wins, so a stale checkout can never shadow the shipped one, and
// a present-but-broken deployed bundle still reaches the loader (surfacing as
// `webclient_bundle_unverified`) instead of being silently stepped over.
//
// `sourceTreeDir` is injected throughout: whether THIS checkout has been built
// is not a property these tests may inherit. `installedDir` is injected for the
// identical reason — its real probe reads `process.execPath`, so under vitest it
// asks whether the machine's NODE binary happens to have a `webclient` directory
// beside it. That is almost always false, which is exactly what makes it a bad
// thing to leave unpinned: the suite would pass everywhere until it didn't.
describe('dev serve flow — resolveServedWebclientBundleDir', () => {
  const SRC = '/repo/apps/webclient/build';
  const srcBuilt = (): string | undefined => SRC;
  const srcUnbuilt = (): string | undefined => undefined;
  const noInstalled = (): string | undefined => undefined;

  it('a deployed bundle WINS over a built source tree (no shadowing on a real install)', () => {
    seedValidBundle(); // `dir` now holds a manifest — i.e. an installed bundle
    expect(resolveServedWebclientBundleDir(undefined, dir, srcBuilt, noInstalled)).toBe(dir);
  });

  it('a deployed bundle wins via the CAS sibling too, not just the override', () => {
    const blobs = join(dir, 'cas', 'blobs');
    const sibling = join(dir, 'cas', 'webclient'); // `webclient` sibling OF THE BLOB ROOT
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, WEBCLIENT_BUNDLE_MANIFEST_FILENAME), '{"files":[]}', 'utf8');
    expect(resolveServedWebclientBundleDir(blobs, undefined, srcBuilt, noInstalled)).toBe(sibling);
  });

  it('a deployed dir with a BROKEN manifest still wins — the loader must see it', () => {
    // Not valid JSON: the loader throws `manifest_malformed_json` and the mount
    // stays dormant with a loud log. Stepping over it to the source tree would
    // silently serve something else on a tampered install.
    writeFileSync(join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME), '{ not json', 'utf8');
    expect(resolveServedWebclientBundleDir(undefined, dir, srcBuilt, noInstalled)).toBe(dir);
  });

  it('falls through to the source tree when the deployment dir holds nothing', () => {
    const empty = join(dir, 'no-bundle-here');
    expect(resolveServedWebclientBundleDir(undefined, empty, srcBuilt, noInstalled)).toBe(SRC);
  });

  it('returns the deployment dir unchanged when neither has a bundle (dormant, as before)', () => {
    const empty = join(dir, 'no-bundle-here');
    expect(resolveServedWebclientBundleDir(undefined, empty, srcUnbuilt, noInstalled)).toBe(empty);
  });

  it('undefined on a dbless boot with an unbuilt checkout', () => {
    expect(resolveServedWebclientBundleDir(undefined, undefined, srcUnbuilt, noInstalled)).toBeUndefined();
  });

  it('a dbless boot in a BUILT checkout still serves — the dev-run case', () => {
    expect(resolveServedWebclientBundleDir(undefined, undefined, srcBuilt, noInstalled)).toBe(SRC);
  });
});

describe('dev serve flow — resolveSourceTreeWebclientDir (the real probe)', () => {
  // State-independent: this repo may or may not have run the webclient build.
  // Both outcomes are asserted for the property that matters — it points at
  // `apps/webclient/build` and answers non-undefined ONLY with a manifest there.
  it('points at apps/webclient/build and gates on the manifest actually being there', () => {
    const resolved = resolveSourceTreeWebclientDir();
    const expected = join(repoRoot, 'apps', 'webclient', 'build');
    const built = existsSync(join(expected, WEBCLIENT_BUNDLE_MANIFEST_FILENAME));
    expect(resolved).toBe(built ? expected : undefined);
  });

  it('is a source-tree path — never a data volume or a temp dir', () => {
    const resolved = resolveSourceTreeWebclientDir();
    if (resolved !== undefined) expect(resolved.endsWith(join('apps', 'webclient', 'build'))).toBe(true);
  });
});

// ── Install-dir tier — resolveInstalledWebclientDir ────────────────────────
//
// ⛔ THE GAP THIS CLOSES. `install.sh` has to put the bundle SOMEWHERE, and the
// deployment dir is not a candidate: it is derived from the CAS root, which
// hangs off `dbPath`, which defaults to `./recued-server.db` — relative to the
// working directory the owner happened to run `recued serve` from. So the
// installer writes beside the binary instead, and this tier is what makes those
// bytes reachable. Without it the installer's work is invisible and `/webclient`
// 404s on every fresh install, which is precisely what it did.
describe('install-dir tier — resolveInstalledWebclientDir', () => {
  const exeDirWith = (name: string, seedBundle: boolean): string => {
    const home = join(dir, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'recued'), '#!/bin/sh\n', 'utf8');
    if (seedBundle) {
      mkdirSync(join(home, 'webclient'), { recursive: true });
      writeFileSync(
        join(home, 'webclient', WEBCLIENT_BUNDLE_MANIFEST_FILENAME),
        '{"files":[]}',
        'utf8',
      );
    }
    return home;
  };

  it('finds the bundle beside the executable', () => {
    const prefix = exeDirWith('prefix', true);
    // realpath'd on both sides: macOS hands out temp dirs under `/var`, which is
    // itself a symlink to `/private/var`, and the resolver resolves what it is
    // given. Comparing raw paths here would fail on macOS and pass on Linux.
    expect(resolveInstalledWebclientDir(join(prefix, 'recued')))
      .toBe(realpathSync(join(prefix, 'webclient')));
  });

  it('undefined when nothing is beside the executable — never a bogus dir', () => {
    // The npm / node-on-PATH install: execPath is the NODE binary, and
    // `<nodedir>/webclient` is not ours to claim.
    const prefix = exeDirWith('bare', false);
    expect(resolveInstalledWebclientDir(join(prefix, 'recued'))).toBeUndefined();
  });

  it('resolves through the $BINDIR symlink to the real payload dir', () => {
    // `install.sh` puts the exe at $PREFIX/recued and points $BINDIR/recued at
    // it. Looking beside the SYMLINK finds nothing; the bundle is beside the
    // target. Node normally resolves argv[0] itself — this pins the behaviour
    // rather than trusting that it always will.
    const prefix = exeDirWith('linked-prefix', true);
    const bindir = join(dir, 'linked-bin');
    mkdirSync(bindir, { recursive: true });
    symlinkSync(join(prefix, 'recued'), join(bindir, 'recued'));
    expect(resolveInstalledWebclientDir(join(bindir, 'recued')))
      .toBe(realpathSync(join(prefix, 'webclient')));
  });

  it('ranks BELOW the deployment dir, so a self-update always wins', () => {
    // The updater extracts to the deployment dir and never here. If this tier
    // outranked it, an install would pin the owner to the version they first
    // installed and every later update would serve stale assets.
    seedValidBundle();
    const prefix = exeDirWith('losing-prefix', true);
    expect(
      resolveServedWebclientBundleDir(undefined, dir, () => undefined, () =>
        join(prefix, 'webclient')),
    ).toBe(dir);
  });

  it('is reached when the deployment dir and the source tree hold nothing', () => {
    const prefix = exeDirWith('winning-prefix', true);
    const empty = join(dir, 'no-bundle-here');
    expect(
      resolveServedWebclientBundleDir(undefined, empty, () => undefined, () =>
        join(prefix, 'webclient')),
    ).toBe(join(prefix, 'webclient'));
  });
});
