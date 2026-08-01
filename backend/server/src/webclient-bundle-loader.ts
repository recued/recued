/** D-152 § A.16 — production disk loader for the LAN-only webclient bundle.
 *
 *  The substrate-then-wiring counterpart to `createWebclientBundleHandler`
 *  (`webclient-handler.ts`): that factory takes a pre-loaded
 *  `WebclientBundleFile[]` + optional manifest; THIS module is the
 *  production caller that reads them from disk at server boot. The
 *  documented distribution model (per `packages/contracts/.../webclient-bundle.ts`):
 *  a release ships `webclient-vX.Y.Z.tar.gz`, the user extracts it at
 *  `<install-dir>/webclient/`, and the server reads + verifies it on boot.
 *
 *  MANIFEST-DRIVEN load. The shipped `webclient-bundle-manifest.json`
 *  (emitted by `apps/webclient/scripts/build.mjs`) is the source of truth
 *  for WHAT to serve: the loader reads exactly the files it lists and
 *  ignores anything else on disk (stray `.DS_Store`, editor temp files,
 *  an old sourcemap). This keeps the handler the single verification
 *  authority — it re-hashes every returned file and compares against the
 *  manifest, so a corrupt or truncated on-disk file surfaces as a
 *  `bundle_sha256_mismatch` and a manifest entry with no file on disk as a
 *  `bundle_missing_manifest_entry`. Both make the factory throw, and the
 *  production wiring (`compose-listeners.ts`) catches → logs
 *  `webclient_bundle_unverified` → leaves the mount dormant.
 *
 *  Return contract:
 *    - `null`  — nothing to mount, benign + quiet. The bundle directory
 *      doesn't exist, OR it has no `webclient-bundle-manifest.json`. A
 *      server with no dropped-in bundle is the common case (the webclient
 *      is primarily distributed from app.recued.com); `/webclient/*` 404s.
 *    - throws `WebclientBundleLoadError` — the manifest IS present but
 *      can't be trusted (unreadable, malformed JSON, wrong shape). This is
 *      a tampered / partial-extraction signal, distinct from "absent", so
 *      the wiring can warn loudly while still staying dormant.
 *
 *  The factory's own `WebclientBundleVerificationError` (sha / one-to-one
 *  drift) is thrown later, by the handler, not here. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  WEBCLIENT_BUNDLE_MANIFEST_FILENAME,
  WEBCLIENT_BUNDLE_PATH_REGEX,
  verifyWebclientBundle,
  type WebclientBundleFile,
  type WebclientBundleManifest,
} from '@recued/contracts';

/** Result of a successful (non-null) load — the exact shape
 *  `ServerConfig.webclientBundle` expects. */
export interface LoadedWebclientBundle {
  files: ReadonlyArray<WebclientBundleFile>;
  manifest: WebclientBundleManifest;
}

export type WebclientBundleLoadErrorReason =
  | 'manifest_unreadable'
  | 'manifest_malformed_json'
  | 'manifest_invalid_shape';

/** Thrown when the manifest is present but cannot be trusted. Carries a
 *  closed-list `reason` so the boot wiring can log without parsing
 *  free-text. Absence of the manifest (or the whole directory) is NOT an
 *  error — `loadWebclientBundleFromDisk` returns `null` for that. */
export class WebclientBundleLoadError extends Error {
  readonly reason: WebclientBundleLoadErrorReason;
  constructor(reason: WebclientBundleLoadErrorReason, detail?: string) {
    super(`webclient_bundle_load_failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'WebclientBundleLoadError';
    this.reason = reason;
  }
}

const isErrnoException = (e: unknown): e is NodeJS.ErrnoException =>
  e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string';

/** Node ENOENT (file/dir not found) — the benign "no bundle here" path. */
const isNotFound = (e: unknown): boolean =>
  isErrnoException(e) && e.code === 'ENOENT';

/** Minimal structural guard for the parsed manifest JSON. The contract's
 *  `verifyWebclientBundle` validates path / sha256 grammar + one-to-one
 *  matching, but it assumes `manifest.files` is already an array of
 *  `{ path, sha256 }` — a manifest that parsed to some other JSON shape
 *  would crash it (`.files.length` on undefined). This guard catches that
 *  at the loader boundary and turns it into a typed error. */
const isManifestShape = (parsed: unknown): parsed is WebclientBundleManifest => {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files)) return false;
  return files.every(
    (f) =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as { path?: unknown }).path === 'string' &&
      typeof (f as { sha256?: unknown }).sha256 === 'string',
  );
};

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** D-152 § A.16 + R26.2 Delta 3 — resolve the on-disk bundle directory the
 *  server reads at boot. `dirOverride` (from `RECUED_WEBCLIENT_DIR`) wins for
 *  dev / non-standard layouts; otherwise the bundle lives at a `webclient`
 *  sibling of the CAS blob root (the same data-volume convention as the
 *  messenger media scratch dir). Returns undefined when neither is available
 *  (dbless / boot-phase with no CAS). Shared by the serving path
 *  (`compose-listeners`) + the apex-setter servability probe
 *  (`compose-ingress-rpc-context`) so the dir convention lives in one place. */
export const resolveWebclientBundleDir = (
  cacheBlobsRoot: string | undefined,
  dirOverride: string | undefined,
): string | undefined =>
  dirOverride?.trim() ||
  (cacheBlobsRoot ? join(dirname(cacheBlobsRoot), 'webclient') : undefined);

/** True iff `dir` holds a bundle manifest — the cheap "is there anything to
 *  load here" probe the candidate walk below uses to choose between dirs.
 *  Absence is the loader's benign null path, so this never distinguishes a
 *  missing dir from a missing manifest: both mean "nothing here". */
const hasBundleManifest = (dir: string): boolean =>
  existsSync(join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME));

/** The webclient build output inside a SOURCE CHECKOUT — `apps/webclient/build`,
 *  resolved from this module's own directory (`backend/server/src/../../..` =
 *  repo root), the same trick `recipe-store.ts` uses for `community/recipes`.
 *
 *  Returns undefined unless that path actually holds a built bundle, which is
 *  true only in a git clone that has run `apps/webclient/scripts/build.mjs`. In
 *  a packaged install (npm / binary / Docker) the path does not exist, so this
 *  tier is structurally dev-only — no env var, no flag, nothing to leave set. */
export const resolveSourceTreeWebclientDir = (): string | undefined => {
  const dir = resolve(
    import.meta.dirname ?? __dirname,
    '..',
    '..',
    '..',
    'apps',
    'webclient',
    'build',
  );
  return hasBundleManifest(dir) ? dir : undefined;
};

/** The dir the SERVING path reads — `resolveWebclientBundleDir` plus a
 *  source-checkout fallback, so `tsx backend/server/src/bin.ts serve` in a
 *  clone serves the webclient it just built without an env var.
 *
 *  Precedence is deliberately "a real bundle always wins":
 *    1. the deployment dir (`RECUED_WEBCLIENT_DIR` / CAS sibling) when it holds
 *       a manifest — an installed bundle is never shadowed by a stale checkout,
 *       and its present-but-untrusted / drifted outcomes still surface as the
 *       loader's typed error rather than being silently skipped;
 *    2. the source-tree build, when one exists;
 *    3. the deployment dir as-is (the common "nothing anywhere" → dormant path,
 *       keeping the absent-dir semantics identical to before).
 *
 *  Serving + the servability probe share this so they agree. The self-update
 *  EXTRACT target deliberately does NOT: it stays on `resolveWebclientBundleDir`
 *  so an update can never write into a developer's source tree.
 *
 *  `sourceTreeDir` is a test seam — the source tier's answer depends on whether
 *  the checkout happens to have been built, which a test must not inherit.
 *  Production callers pass two arguments and get the real probe. */
export const resolveServedWebclientBundleDir = (
  cacheBlobsRoot: string | undefined,
  dirOverride: string | undefined,
  sourceTreeDir: () => string | undefined = resolveSourceTreeWebclientDir,
): string | undefined => {
  const deployed = resolveWebclientBundleDir(cacheBlobsRoot, dirOverride);
  if (deployed && hasBundleManifest(deployed)) return deployed;
  return sourceTreeDir() ?? deployed;
};

/** R26.2 Delta 3 — boot-time servability probe for the apex `serve_webclient`
 *  consistency gate. Returns true iff a VERIFIED bundle is present at `dir` —
 *  exactly the predicate the serving path applies (`createServerHandlerSet`
 *  only builds the `webclient` handler when `config.webclientBundle` is the
 *  result of this same load + `verifyWebclientBundle`). So the
 *  `exposure.set_apex` setter and the live serving gate agree: a present-but-
 *  untrusted manifest (load throws) or a sha / one-to-one drift (verify fails)
 *  both collapse to `false`, matching `compose-listeners` dropping the mount.
 *  Never throws — any load/verify failure → not servable. */
export const isVerifiedWebclientBundlePresent = async (
  dir: string,
): Promise<boolean> => {
  try {
    const loaded = await loadWebclientBundleFromDisk(dir);
    if (!loaded) return false;
    return verifyWebclientBundle(loaded.manifest, loaded.files).ok;
  } catch {
    // Present-but-untrusted manifest (unreadable / malformed / wrong shape) —
    // the serving path logs `webclient_bundle_unverified` + stays dormant, so
    // treat it as not servable here too (the apex would 404 anyway).
    return false;
  }
};

/** Load the webclient bundle from `dir` (the directory the release tarball
 *  extracts to). See the module header for the return / throw contract. */
export const loadWebclientBundleFromDisk = async (
  dir: string,
): Promise<LoadedWebclientBundle | null> => {
  // 1. Read the integrity manifest. Its absence (or the directory's) ⇒
  //    nothing to mount (null). Any other read failure ⇒ the manifest is
  //    present-but-unreadable ⇒ typed error (don't silently mount).
  const manifestPath = join(dir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME);
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return null;
    throw new WebclientBundleLoadError(
      'manifest_unreadable',
      isErrnoException(e) ? e.code : undefined,
    );
  }

  // 2. Parse + shape-check.
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    throw new WebclientBundleLoadError('manifest_malformed_json');
  }
  if (!isManifestShape(parsed)) {
    throw new WebclientBundleLoadError('manifest_invalid_shape');
  }
  const manifest = parsed;

  // 3. Manifest-driven read: pull exactly the listed files. A listed file
  //    missing on disk is dropped here (ENOENT) — the handler's one-to-one
  //    verify then reports `bundle_missing_manifest_entry` + throws. Any
  //    other read error is genuine corruption ⇒ surface it as unreadable.
  // Canonical bundle root for the per-file containment check below. `dir`
  // exists here (the manifest was just read from it). Resolving it lets an
  // operator legitimately point the bundle dir itself at a symlink while still
  // blocking per-file escapes, and canonicalizes platform quirks (e.g. macOS
  // `/var` → `/private/var`) so the prefix check compares like for like.
  const bundleRoot = await realpath(dir);

  const files: WebclientBundleFile[] = [];
  for (const entry of manifest.files) {
    // Path-safety BEFORE touching the filesystem. The manifest ships inside
    // the bundle (bundle-trust), but a crafted `..` / absolute / backslash
    // entry must never make the loader `readFile` OUTSIDE the bundle dir.
    // Skip unsafe entries here; `verifyWebclientBundle` then reports
    // `manifest_path_invalid` and the wiring stays dormant. (Same regex the
    // handler enforces per request — defense at both boundaries.)
    if (!WEBCLIENT_BUNDLE_PATH_REGEX.test(entry.path)) continue;

    // Symlink-escape guard. The regex blocks traversal in the path STRING, but
    // a regex-clean entry could be (or traverse) a symlink whose target lives
    // outside the bundle — following it would read an arbitrary server-readable
    // file into the served set. Resolve the real path and require it to stay
    // within the canonical bundle root; an escaping or missing entry is
    // skipped, so `verifyWebclientBundle` reports the gap and the mount stays
    // dormant. We then read the resolved real path (not the symlink) directly.
    const abs = join(dir, entry.path);
    let real: string;
    try {
      real = await realpath(abs);
    } catch (e) {
      if (isNotFound(e)) continue; // missing on disk → verify reports the gap
      throw new WebclientBundleLoadError(
        'manifest_unreadable',
        `${entry.path}: ${isErrnoException(e) ? e.code : 'realpath_error'}`,
      );
    }
    if (real !== bundleRoot && !real.startsWith(bundleRoot + sep)) continue;

    let bytes: Buffer;
    try {
      bytes = await readFile(real);
    } catch (e) {
      if (isNotFound(e)) continue;
      throw new WebclientBundleLoadError(
        'manifest_unreadable',
        `${entry.path}: ${isErrnoException(e) ? e.code : 'read_error'}`,
      );
    }
    // Re-hash from disk bytes (the handler re-hashes again at the serving
    // boundary; computing here keeps the returned file self-consistent and
    // means a corrupt file fails verification even if its manifest claim
    // were trusted).
    files.push({ path: entry.path, sha256: sha256Hex(bytes), bytes });
  }

  return { files, manifest };
};
