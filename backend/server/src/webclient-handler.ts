/** D-152 § A.16 — webclient bundle handler.
 *
 *  Static-file mount that serves a pre-loaded bundle of webclient PWA assets at
 *  `/webclient/*`.
 *
 *  ⚠ NO LONGER LAN-ONLY, AND THIS HEADER SAID IT WAS. R26.2 Delta 3 made
 *  `webclient` a first-class exposure path role, and `server.ts` threads this
 *  handler onto BOTH listeners — "wired identically on both", with the
 *  per-listener `resolution.webclient` grid bit deciding where it serves
 *  (LAN-on, public-off by DEFAULT, public being an explicit per-row opt-in).
 *  The stale sentence mattered: it reads as a hard architectural fence and is
 *  really a default, which is the difference between "you cannot serve the app
 *  on 443" and "you have not switched it on".
 *
 *  ⇒ One public listener (443 by default) can serve reception AND the webclient
 *  at once — they are independent rows in the grid, and only the bare `/` apex
 *  is an exclusive choice.
 *
 *  Off-grid scenario (the original FU#7 deferred concern): an air-gapped
 *  server is reachable on `192.168.x.x` and serves the full webclient PWA
 *  without anyone loading `app.recued.com`.
 *
 *  ⛔ BUT NOT OVER PLAIN `http://192.168.x.x/webclient/`, and this header used
 *  to say it was. A plain-http LAN IP is NOT a secure context, so
 *  `crypto.subtle` is undefined — and the webclient's token store, ed25519
 *  verifier and key generation are all built on it. `boot/secure-context-guard.
 *  ts` detects exactly this and mounts the guided secure-access handoff instead
 *  of letting every crypto call throw; a real load from another device on the
 *  LAN reaches that screen, not the app. That guard is CORRECT — the browser
 *  rule is not ours to opt out of — so what was wrong was this promise.
 *
 *  What actually works today: `http://localhost:<port>/` ON THE SERVER MACHINE
 *  (loopback is a secure-context exception), or any device once the server has
 *  trusted HTTPS — Pro DDNS + ACME, an operator-provisioned cert, OR an upstream
 *  proxy holding the cert while this listener binds plaintext behind it
 *  (`path-listener-coordinator.ts`: "null/empty holder → public listener binds
 *  plaintext"). That third option is the one that costs the project nothing.
 *  Another phone or laptop over a bare LAN IP needs that HTTPS first. Serving these
 *  files is still right — the handler is what a LAN HTTPS listener serves — but
 *  the transport is a precondition, not an afterthought.
 *
 *  Substrate scope:
 *
 *  - The factory takes a pre-loaded `ReadonlyArray<WebclientBundleFile>`
 *    + an optional `WebclientBundleManifest`; verification runs at
 *    factory time, NOT per request. Caller is responsible for loading
 *    bundle files from disk (production) or constructing them in-memory
 *    (tests).
 *  - GET / HEAD only; everything else 405 with `Allow: GET, HEAD`.
 *  - Path safety: incoming `/webclient/foo/bar.js` strips to `foo/bar.js`
 *    via `WEBCLIENT_BUNDLE_PATH_REGEX`; mismatches → 404 with the same
 *    generic body as the path-router's unknown-path 404. Path traversal
 *    attempts (`/webclient/../etc/passwd`, `/webclient/foo\\bar`, etc.)
 *    fall out at the regex layer.
 *  - MIME types derived from file extension (closed list — anything
 *    not in the list serves as `application/octet-stream`).
 *  - Cache headers: every stable-named shell asset revalidates
 *    (`SHORT_CACHE_PATHS`); only genuinely immutable assets take
 *    `max-age=3600`. The build emits FIXED filenames, so revalidation is
 *    the only freshness mechanism there is — see the note on that set.
 *    Bundle-content integrity comes from manifest verification at boot,
 *    not from per-asset hash querystrings.
 *  - Strict Content-Security-Policy header on every response — the
 *    webclient runs strictly within `'self'` for scripts + styles. The
 *    user-typed server URL is reached via `connect-src 'self' ws: wss:
 *    http: https:` (no wildcard; connect-src accepts the scheme list).
 *
 *  Not in this slice (substrate-then-wiring discipline per FU2 / FU5 /
 *  FU3 / FU7):
 *
 *  - Disk-loading helper (production wiring will compose
 *    `loadWebclientBundleFromDisk` separately when the bundle release
 *    artifact exists). The handler accepts the loaded bundle directly
 *    so tests can construct in-memory fixtures.
 *  - SPA fallback (serve index.html on path miss). Exact path matching
 *    only — if a future bundle uses client-side routing in a way that
 *    requires fallback, that lands when the bundle exists.
 *  - Audit emission for `webclient_bundle_unverified` failures. The
 *    factory throws; the production wiring is responsible for
 *    catch-and-audit at boot time. */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  WEBCLIENT_PATH_PREFIX,
  WEBCLIENT_BUNDLE_PATH_REGEX,
  verifyWebclientBundle,
  type WebclientBundleFile,
  type WebclientBundleManifest,
  type WebclientBundleVerifyIssue,
} from '@recued/contracts';
import type { PortRequestHandler } from '@recued/server-tls';

export interface WebclientHandlerOptions {
  /** Pre-loaded bundle files. Caller hashes + reads from whatever
   *  source they like (disk in production; in-memory in tests). */
  files: ReadonlyArray<WebclientBundleFile>;
  /** Optional manifest. When provided, the factory runs
   *  `verifyWebclientBundle` BEFORE returning the handler — manifest
   *  drift throws `WebclientBundleVerificationError`. Production
   *  wiring SHOULD supply the manifest so tampered bundles refuse to
   *  mount; tests may omit when exercising request-side dispatch in
   *  isolation. */
  manifest?: WebclientBundleManifest;
  /** Optional structured logger. Receives one entry per dispatch
   *  decision (`served` / `not_found` / `method_not_allowed`).
   *  Diagnostic only; never affects behavior. */
  log?: (
    level: 'info' | 'warn',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

export class WebclientBundleVerificationError extends Error {
  readonly issues: ReadonlyArray<WebclientBundleVerifyIssue>;
  constructor(issues: ReadonlyArray<WebclientBundleVerifyIssue>) {
    super(`webclient_bundle_unverified: ${issues.length} issue${issues.length === 1 ? '' : 's'}`);
    this.name = 'WebclientBundleVerificationError';
    this.issues = issues;
  }
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/** D-152 § A.16 — strict CSP for the LAN-only webclient. Same posture
 *  as `app.recued.com`'s public CSP: scripts/styles strictly `'self'`,
 *  no inline scripts, no `eval`, no remote origins. `connect-src`
 *  enumerates the schemes the user-typed server URL may use (the
 *  webclient is a thin client — all data + management RPCs flow over
 *  the user's typed URL). `frame-ancestors 'none'` blocks the webclient
 *  from being embedded in third-party frames. */
const WEBCLIENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss: http: https:",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** D-152 § A.16 — closed-list MIME type map keyed by lowercase
 *  extension. Anything not in the map serves as
 *  `application/octet-stream` — bundle authors should restrict to the
 *  set below; binary blob fallback exists for future formats but
 *  shouldn't be exercised in practice. */
const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  // ⛔ MISSING until 2026-08-08, and the omission was invisible: the PWA
  // manifest fell to `application/octet-stream`, which this handler serves
  // WITH `X-Content-Type-Options: nosniff`. Chromium happens to parse a
  // `<link rel="manifest">` anyway, so nothing errored — it just made the one
  // file whose whole job is install identity the least portable thing served.
  webmanifest: 'application/manifest+json',
};

const DEFAULT_MIME = 'application/octet-stream';

/** Paths that must not be cached: everything whose FILENAME IS STABLE across
 *  builds, which — contrary to what this comment used to claim — is all of them.
 *
 *  ⛔ IT SAID: "`index.html` + the PWA `manifest.json` … everything else is
 *  `max-age=3600` — bundles ship with hashed asset filenames so freshness comes
 *  from the URL changing". Two things wrong with that, both silent:
 *
 *    1. THERE IS NO `manifest.json`. The file is `manifest.webmanifest`
 *       (`apps/webclient/public/`), so this set matched nothing and the manifest
 *       took the hour-long cache.
 *    2. NOTHING IS HASHED. `apps/webclient/scripts/build.mjs` emits a FIXED
 *       `webclient-main.js` (+ `.map`), and `sw.js` says so in capitals. So the
 *       "freshness comes from the URL changing" premise is false for the one
 *       asset it matters most for: a returning browser served
 *       `max-age=3600` runs an hour-old bundle against a just-restarted server.
 *
 *  Until the build emits content-hashed names, correctness has to come from
 *  revalidation, so the shell entry points revalidate and the long cache is
 *  reserved for genuinely immutable assets (fonts, images). `no-cache,
 *  must-revalidate` still allows a 304 — this costs a conditional request per
 *  asset per load on a LAN, not a re-download. */
const SHORT_CACHE_PATHS = new Set([
  'index.html',
  'manifest.webmanifest',
  'boot-shell.js',
  'sw.js',
  'webclient-main.js',
  'webclient-main.js.map',
  'tokens.css',
  'oauth-callback.html',
]);

const SHORT_CACHE_HEADER = 'no-cache, must-revalidate';
const LONG_CACHE_HEADER = 'public, max-age=3600';

const lookupMime = (path: string): string => {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return DEFAULT_MIME;
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? DEFAULT_MIME;
};

const lookupCacheControl = (path: string): string =>
  SHORT_CACHE_PATHS.has(path) ? SHORT_CACHE_HEADER : LONG_CACHE_HEADER;

/** D-152 § A.16 — factory. Throws `WebclientBundleVerificationError`
 *  when a manifest is provided and the loaded bundle fails
 *  verification. Production wiring catches at boot + emits the
 *  `webclient_bundle_unverified` audit row + skips the mount.
 *
 *  Re-hash discipline (Codex W3.FU8 P2 fold): the factory recomputes
 *  `sha256(file.bytes)` at the serving boundary BEFORE running the
 *  manifest comparison, ignoring the caller's `file.sha256` claim. A
 *  caller that incorrectly pairs hash+bytes (copy-paste error, stale
 *  metadata, partial reload) can no longer slip past the manifest
 *  gate. The verifier sees the actual hash of what will be served, so
 *  manifest-vs-bundle mismatch is genuine, not a metadata trust issue. */
export const createWebclientBundleHandler = (
  opts: WebclientHandlerOptions,
): PortRequestHandler => {
  // Codex W3.FU8 P2 #1 fold — re-hash every file at the serving
  // boundary so the manifest gate compares against bytes-on-the-wire,
  // not the caller's `sha256` claim. The verifier then sees ground
  // truth even if the caller's metadata was incorrect.
  const rehashedFiles: WebclientBundleFile[] = opts.files.map((file) => ({
    path: file.path,
    sha256: sha256Hex(file.bytes),
    bytes: file.bytes,
  }));

  if (opts.manifest) {
    const result = verifyWebclientBundle(opts.manifest, rehashedFiles);
    if (!result.ok) {
      throw new WebclientBundleVerificationError(result.issues);
    }
  }

  // Build lookup map from the re-hashed files (so the serving path
  // uses verified-bytes-paired-with-verified-hash; the caller's
  // potentially-stale `sha256` metadata is never trusted).
  const byPath = new Map<string, WebclientBundleFile>();
  for (const file of rehashedFiles) {
    byPath.set(file.path, file);
  }
  const log = opts.log;

  return (req: IncomingMessage, res: ServerResponse): void => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      log?.('info', 'webclient: 405 (method not allowed)', { method });
      respond405(res);
      return;
    }

    const url = req.url ?? '/';
    const queryIdx = url.indexOf('?');
    const hashIdx = url.indexOf('#');
    let end = url.length;
    if (queryIdx >= 0) end = Math.min(end, queryIdx);
    if (hashIdx >= 0) end = Math.min(end, hashIdx);
    const pathRaw = url.slice(0, end);

    // Bare `/webclient` or `/webclient/` → index.html. Other matches
    // strip the prefix + trailing slash variants.
    let relative: string;
    if (pathRaw === WEBCLIENT_PATH_PREFIX || pathRaw === WEBCLIENT_PATH_PREFIX + '/') {
      relative = 'index.html';
    } else if (pathRaw.startsWith(WEBCLIENT_PATH_PREFIX + '/')) {
      relative = pathRaw.slice((WEBCLIENT_PATH_PREFIX + '/').length);
      // Directory-style request — serve the directory's index.html.
      if (relative.endsWith('/')) {
        relative = relative + 'index.html';
      }
    } else {
      // Path-router should have already filtered for the prefix, but
      // defensively 404 anything else that somehow reached the handler.
      log?.('info', 'webclient: 404 (path outside prefix)', { path: pathRaw });
      respond404(res);
      return;
    }

    // Path safety — same regex the contract validator uses at bundle-
    // load time. Defends against `..`, `\0`, backslashes, leading
    // slashes, and `//` sequences.
    if (!WEBCLIENT_BUNDLE_PATH_REGEX.test(relative)) {
      log?.('info', 'webclient: 404 (path-safety reject)', { path: pathRaw, relative });
      respond404(res);
      return;
    }

    const file = byPath.get(relative);
    if (!file) {
      log?.('info', 'webclient: 404 (file not in bundle)', { path: pathRaw, relative });
      respond404(res);
      return;
    }

    log?.('info', 'webclient: 200', { path: pathRaw, relative });
    respondFile(res, file, method);
  };
};

const respondFile = (
  res: ServerResponse,
  file: WebclientBundleFile,
  method: string,
): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 200;
  res.setHeader('content-type', lookupMime(file.path));
  res.setHeader('cache-control', lookupCacheControl(file.path));
  res.setHeader('content-security-policy', WEBCLIENT_CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-length', String(file.bytes.byteLength));
  if (method === 'HEAD') {
    res.end();
    return;
  }
  // Node's `ServerResponse.end` accepts Buffer | Uint8Array | string.
  res.end(file.bytes);
};

const respond404 = (res: ServerResponse): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: { code: 'not_found' } }));
};

const respond405 = (res: ServerResponse): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 405;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('allow', 'GET, HEAD');
  res.end(JSON.stringify({ error: { code: 'method_not_allowed' } }));
};

/** D-152 § A.16 — SHA-256 of a byte sequence as 64-char lowercase hex.
 *  Matches the manifest's `sha256` shape (per
 *  `WEBCLIENT_BUNDLE_SHA256_REGEX`). Re-computed at the serving
 *  boundary so caller-supplied `WebclientBundleFile.sha256` is treated
 *  as untrusted metadata. */
const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
