/** D-152 § A.16 — LAN-only self-hosted webclient bundle substrate.
 *
 *  The webclient PWA at `app.recued.com` is the primary distribution
 *  origin; this substrate ships a parallel path so users who can't reach
 *  app.recued.com (air-gapped LAN-only deployments, geofenced visitors
 *  to app.recued.com, the user's "I want OFF Recued's cloud entirely"
 *  story) can run the same webclient from their local server.
 *
 *  Distribution:
 *
 *  - Webclient sources live in a separate AGPL repo (`recued/webclient`);
 *    builds produce a static bundle with relative asset paths + stripped
 *    analytics/CDN imports. Server URL is already user-typed at pair
 *    time so the bundle has no hardcoded `app.recued.com` runtime
 *    dependency beyond optional OAuth callback flows.
 *  - Release bundle ships as `webclient-vX.Y.Z.tar.gz` alongside
 *    `recued-server` release artifacts; user downloads + drops in place
 *    at `<install-dir>/webclient/`.
 *  - Server boot reads the bundle into memory + verifies against a
 *    shipped `WebclientBundleManifest` (SHA-256 per file); mismatch →
 *    emit `webclient_bundle_unverified` log + refuse to mount.
 *
 *  Serving:
 *
 *  - The path-router dispatches `/webclient` + `/webclient/*` requests
 *    on the LAN listener to the bundle handler BEFORE role lookup. The
 *    PUBLIC listener never serves the bundle — visitors hitting
 *    `<handle>.recued.cloud/webclient/...` get the dispatcher's generic
 *    404 (same shape as unknown paths; no fingerprint of the LAN-only
 *    mount).
 *  - LAN-only by structural design (path-router gates on
 *    `listener === 'lan'`); no Exposure-grid toggle, no preset-map
 *    cascade. If a future amendment wants public exposure under an
 *    explicit Mary-acknowledgement gate, that lands separately —
 *    the substrate's invariant today is "LAN listener only".
 *
 *  Off-grid scenario this addresses (the original FU#7 deferred
 *  concern): an air-gapped server is reachable on `192.168.x.x` from
 *  Mary's LAN-local browser. Mary opens `http://192.168.x.x/webclient/`
 *  and gets the full webclient PWA — pair flow + recipe management +
 *  data browse + Settings — without ever loading `app.recued.com`.
 *  OAuth-mediated provider connections fail gracefully (provider
 *  callback can't reach the air-gapped server anyway, so the UI surface
 *  is inert in that scenario — same UX as today's app.recued.com when
 *  a provider is down).
 *
 *  Scope (NOT in this substrate):
 *
 *  - The webclient repo itself + its build pipeline. The substrate
 *    ships ahead of the bundle (substrate-then-wiring per FU2 / FU5 /
 *    FU3 / FU7 pattern). Once the bundle exists, the production wiring
 *    composes it; until then, the handler factory has no bundle to
 *    serve + the mount is dormant.
 *  - Public listener exposure. Future amendment may add a Mary-
 *    acknowledgement gate; the LAN-only invariant holds at v1.
 *  - SPA fallback (serve index.html on path miss). Exact path matching
 *    only at v1; if a future bundle uses client-side routing in a way
 *    that requires fallback, that lands in the wiring slice. */

/** D-152 § A.16 — path prefix the path-router carves out on the LAN
 *  listener. Trailing slash is significant — sub-path requests under
 *  `/webclient/*` are bundle assets; the bare `/webclient` path serves
 *  the bundle's `index.html`. */
export const WEBCLIENT_PATH_PREFIX = '/webclient' as const;

/** D-152 § A.16 — filename of the integrity manifest a bundle release
 *  ships alongside its served assets (inside the bundle directory). The
 *  build pipeline (`apps/webclient/scripts/build.mjs`) emits it; the
 *  server's disk loader (`backend/server/src/webclient-bundle-loader.ts`)
 *  reads it and passes the parsed `WebclientBundleManifest` to the handler
 *  for boot-time verification. This file is bundle METADATA, not a served
 *  asset — the loader excludes it from the `WebclientBundleFile[]` it
 *  returns, and the manifest never lists itself. The build script
 *  hardcodes this same literal (it runs as a standalone node ESM script
 *  that can't import the contracts package); keep the two in sync. */
export const WEBCLIENT_BUNDLE_MANIFEST_FILENAME = 'webclient-bundle-manifest.json' as const;

/** D-152 § A.16 — manifest published alongside a bundle release. Server
 *  boot verifies each file's SHA-256 matches the manifest entry before
 *  the bundle is allowed to mount. Mismatch on any entry → the entire
 *  bundle is refused (atomic verification — partial-trust mounts would
 *  defeat the integrity guarantee).
 *
 *  Empty manifest (`files: []`) is structurally invalid — the verifier
 *  rejects it because a bundle with no files would silently mount as
 *  an empty static-file surface (and the bundle is supposed to ship the
 *  webclient at minimum `index.html`). Bundle releases MUST list every
 *  file they want served. */
export interface WebclientBundleManifest {
  /** Release-custody provenance. Runtime integrity verification deliberately
   * ignores it; `release-build` requires the exact clean revision/config before
   * it signs an archive. Optional for legacy on-disk bundles. */
  readonly build?: WebclientBundleBuildAttestation;
  readonly files: ReadonlyArray<WebclientBundleManifestEntry>;
}

export interface WebclientBundleBuildAttestation {
  readonly schema: 1;
  readonly source_revision: string | null;
  readonly source_dirty: boolean;
  readonly cloud_apex: string;
  readonly minified: boolean;
}

export interface WebclientBundleManifestEntry {
  /** Relative path within the bundle. Forward-slash separated; no
   *  leading slash; no `..` segments; no `\0` or backslash. The handler
   *  rejects any incoming request whose post-prefix path doesn't match
   *  exactly one entry in the loaded bundle. Path safety is enforced
   *  at handler-request time + at bundle-load time. */
  readonly path: string;
  /** Lowercase SHA-256 hex of the file contents. Matches what
   *  `crypto.createHash('sha256').update(bytes).digest('hex')` returns
   *  in Node. */
  readonly sha256: string;
}

/** D-152 § A.16 — in-memory representation of a single bundle file.
 *  Production callers load these from disk at server boot; tests
 *  construct them in-memory. The handler factory takes a
 *  `ReadonlyArray<WebclientBundleFile>` directly — bundle loading is
 *  the caller's responsibility. */
export interface WebclientBundleFile {
  /** Relative path within the bundle — same shape as the manifest
   *  entry. Match key for incoming requests after prefix-strip. */
  readonly path: string;
  /** Lowercase SHA-256 hex of `bytes`. The handler verifies that the
   *  caller-supplied `sha256` matches the actual hash of `bytes` —
   *  guards against the caller accidentally pairing the wrong hash
   *  with the wrong file. */
  readonly sha256: string;
  /** File contents. */
  readonly bytes: Uint8Array;
}

/** D-152 § A.16 — closed list of error codes emitted by the bundle
 *  verifier. Returned by `verifyWebclientBundle` so callers can
 *  diagnose mismatches without parsing free-text. */
export type WebclientBundleVerifyErrorCode =
  | 'manifest_empty'
  | 'manifest_path_invalid'
  | 'manifest_sha256_malformed'
  | 'manifest_path_duplicate'
  | 'bundle_path_invalid'
  | 'bundle_sha256_mismatch'
  | 'bundle_missing_manifest_entry'
  | 'bundle_extra_file';

export const WEBCLIENT_BUNDLE_VERIFY_ERROR_CODES: ReadonlyArray<WebclientBundleVerifyErrorCode> = [
  'manifest_empty',
  'manifest_path_invalid',
  'manifest_sha256_malformed',
  'manifest_path_duplicate',
  'bundle_path_invalid',
  'bundle_sha256_mismatch',
  'bundle_missing_manifest_entry',
  'bundle_extra_file',
] as const;

export interface WebclientBundleVerifyOk {
  readonly ok: true;
}

export interface WebclientBundleVerifyErr {
  readonly ok: false;
  readonly issues: ReadonlyArray<WebclientBundleVerifyIssue>;
}

export interface WebclientBundleVerifyIssue {
  readonly code: WebclientBundleVerifyErrorCode;
  /** Path that triggered the issue (if applicable). Absent for
   *  `manifest_empty`. */
  readonly path?: string;
  /** Caller-supplied hash that mismatched (for `bundle_sha256_mismatch`). */
  readonly expected_sha256?: string;
  /** Actual hash computed from the bundle file (for `bundle_sha256_mismatch`). */
  readonly actual_sha256?: string;
}

export type WebclientBundleVerifyResult = WebclientBundleVerifyOk | WebclientBundleVerifyErr;

/** D-152 § A.16 — bundle path safety regex. Forward-slash separated
 *  segments of `[a-zA-Z0-9_-]` + optional file extension; no leading
 *  slash; no `..` segments; no `\0` or backslash. Rejects path-traversal
 *  attempts + Windows-style separators at the schema layer so the
 *  handler doesn't have to re-validate per request.
 *
 *  Conservative — rejects legitimate filenames containing spaces,
 *  parens, or Unicode characters. Bundle build pipelines emit asset
 *  hashes + lowercase ASCII filenames anyway; over-restrictive at the
 *  contract layer matches the broader path-router boundary discipline
 *  (`matchesPathRole` is similarly strict). */
export const WEBCLIENT_BUNDLE_PATH_REGEX = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9_\-./]+$/;

/** D-152 § A.16 — SHA-256 hex regex. 64 lowercase hex chars. */
export const WEBCLIENT_BUNDLE_SHA256_REGEX = /^[a-f0-9]{64}$/;

/** D-152 § A.16 — pure validator. Verifies (a) the manifest is
 *  internally consistent (every path safe + every sha256 well-formed +
 *  no duplicate paths) and (b) the loaded bundle matches it
 *  one-to-one (every manifest entry present with matching hash + no
 *  extra files beyond the manifest).
 *
 *  Callers compute file hashes at load time (production: streaming
 *  read from disk; tests: pre-computed in-memory). The validator does
 *  NOT re-hash — it trusts the caller's `sha256` slot to match the
 *  bundle file's actual hash, and only compares against the manifest.
 *  Production wiring may add a re-hash step for defense-in-depth but
 *  that's a per-callsite choice; the contract doesn't enforce it. */
export const verifyWebclientBundle = (
  manifest: WebclientBundleManifest,
  bundle: ReadonlyArray<WebclientBundleFile>,
): WebclientBundleVerifyResult => {
  const issues: WebclientBundleVerifyIssue[] = [];

  if (manifest.files.length === 0) {
    issues.push({ code: 'manifest_empty' });
    return { ok: false, issues };
  }

  const manifestByPath = new Map<string, WebclientBundleManifestEntry>();
  for (const entry of manifest.files) {
    if (!WEBCLIENT_BUNDLE_PATH_REGEX.test(entry.path)) {
      issues.push({ code: 'manifest_path_invalid', path: entry.path });
      continue;
    }
    if (!WEBCLIENT_BUNDLE_SHA256_REGEX.test(entry.sha256)) {
      issues.push({ code: 'manifest_sha256_malformed', path: entry.path });
      continue;
    }
    if (manifestByPath.has(entry.path)) {
      issues.push({ code: 'manifest_path_duplicate', path: entry.path });
      continue;
    }
    manifestByPath.set(entry.path, entry);
  }

  if (issues.length > 0) return { ok: false, issues };

  const seenInBundle = new Set<string>();
  for (const file of bundle) {
    if (!WEBCLIENT_BUNDLE_PATH_REGEX.test(file.path)) {
      issues.push({ code: 'bundle_path_invalid', path: file.path });
      continue;
    }
    const expected = manifestByPath.get(file.path);
    if (!expected) {
      issues.push({ code: 'bundle_extra_file', path: file.path });
      continue;
    }
    if (file.sha256 !== expected.sha256) {
      issues.push({
        code: 'bundle_sha256_mismatch',
        path: file.path,
        expected_sha256: expected.sha256,
        actual_sha256: file.sha256,
      });
      // Path was present in the bundle (just with wrong content);
      // don't re-flag it as `bundle_missing_manifest_entry` below.
      seenInBundle.add(file.path);
      continue;
    }
    seenInBundle.add(file.path);
  }

  for (const expectedPath of manifestByPath.keys()) {
    if (!seenInBundle.has(expectedPath)) {
      issues.push({ code: 'bundle_missing_manifest_entry', path: expectedPath });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true };
};
