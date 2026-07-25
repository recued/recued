/** D-148 follow-up #7 + R26.2 Delta 2 — apex (`GET /`) handler.
 *
 *  R26.2 Delta 2 generalises the original bare-302 redirect into a 4-mode
 *  apex handler, resolved PER-REQUEST from the server-global
 *  `network.apex_mode` runtime-config field (so a change is hot — no
 *  restart). The factory captures GETTERS, not values, because the
 *  path-listener coordinator builds this handler once at boot + reuses the
 *  same instance across every exposure-driven listener rebuild:
 *
 *    - `redirect` (default) — the original bare-302 behaviour below.
 *    - `serve_reception` — delegate the request to the Reception visitor
 *      handler with `req.url` rewritten to `/reception` (the bare intake
 *      page). Gated on `/reception` being public (defensive 404 otherwise
 *      — the picker normally prevents the inconsistent selection).
 *    - `serve_webclient` — same-origin 302 to `/webclient/` (the embedded
 *      webclient path mount). Gated on `getWebclientServable` (a verified
 *      bundle loaded AND `/webclient` public on the grid); not servable →
 *      404. A redirect (not an inline serve) because the bundle's assets
 *      are RELATIVE (`./webclient-main.js`, SW `scope:'./'`): inline-
 *      serving the index at bare `/` would 404 every asset + root-scope
 *      the service worker. The redirect keeps the document URL at
 *      `/webclient/` so relative refs + SW scope resolve correctly.
 *    - `not_found` — the generic 404 floor.
 *
 *  When a visitor hits `https://<handle>.recued.cloud/` (bare root) under
 *  the `redirect` mode, the public listener responds with HTTP 302 +
 *  `Location: https://app.recued.com/`.
 *  The redirect target is a hardcoded constant — the handle from the
 *  inbound Host header is NEVER echoed into the Location URL, query
 *  string, fragment, or path.
 *
 *  Why bare 302 (per `feedback_no_handle_in_redirect_chain`): the handle
 *  is the user's identity surface. Carrying it through the redirect
 *  chain leaks it into (a) the visitor's browser history (a stable
 *  `app.recued.com/?pair=<handle>` URL persists as bookmark / autocomplete),
 *  (b) HTTP Referer headers from any onward request at the webclient
 *  origin, (c) analytics / monitoring at app.recued.com (Recued cloud
 *  sees which handles are being shared and by whom), (d) copy-paste
 *  leakage once the friend's URL bar carries the query string. Pair
 *  pre-fill is a small convenience; handle exposure is durable and
 *  unfixable once it's in the wild. The visitor pairs by hand at the
 *  webclient — the friction is one click; the privacy win is permanent.
 *
 *  Behavior matrix:
 *
 *  | Method        | Host                              | Response               |
 *  | ------------- | --------------------------------- | ---------------------- |
 *  | GET, HEAD     | `<handle>.recued.cloud[:port]`    | 302 → ROOT_REDIRECT_TARGET |
 *  | GET, HEAD     | anything else (BYO domain, IP)    | 404 generic            |
 *  | other         | (any)                             | 405 method-not-allowed |
 *
 *  Listener gating: this handler is threaded onto the PUBLIC listener
 *  only (per `path-listener-set.ts#PathListenerSetOptions.rootHandler`).
 *  The LAN listener never invokes it — LAN visitors are the user
 *  themselves, and a redirect to app.recued.com from a 192.168.x.x bare
 *  root would be confusing rather than helpful.
 *
 *  Fingerprint discipline: BYO custom domains (and bare apex, and
 *  multi-label subdomains) return the same generic 404 shape as
 *  unknown paths through the dispatcher — visitors cannot tell whether
 *  this server runs the root redirect or has the path disabled.
 *
 *  Header discipline: the Location header is the exact `ROOT_REDIRECT_TARGET`
 *  constant; `Cache-Control: no-store` discourages intermediaries from
 *  caching the redirect indefinitely (in case a future slice adds a
 *  user-facing off-switch in the Exposure grid). No `Content-Length`
 *  body is emitted (the 302 carries an empty body). */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_ROOT_APEX_MODE,
  ROOT_REDIRECT_TARGET,
  WEBCLIENT_PATH_PREFIX,
  isProDdnsHost,
  type RootApexMode,
} from '@recued/contracts';
import type { PortRequestHandler } from '@recued/server-tls';

export interface RootApexHandlerOptions {
  /** R26.2 Delta 2 — the live apex mode getter. Read PER REQUEST (the
   *  handler instance is built once at boot + reused). Production wires
   *  `() => runtimeConfig.get('network.apex_mode')`; absent → the
   *  privacy-safe `redirect` default. */
  getApexMode?: () => RootApexMode;
  /** R26.2 Delta 2 — live read of whether `/reception` is public on the
   *  public listener (the `serve_reception` consistency gate). Production
   *  reads `(await exposureMachine.current()).resolution.reception.public`.
   *  Absent or false → `serve_reception` 404s defensively. */
  getReceptionPublic?: () => Promise<boolean> | boolean;
  /** R26.2 Delta 2 — the Reception visitor handler delegated to under
   *  `serve_reception` (its own rate-limit / pause / IP-block apply). The
   *  root handler rewrites `req.url` to `/reception` before delegating
   *  (the handler is `/reception`-prefix-gated). Absent → 404. */
  receptionHandler?: PortRequestHandler;
  /** R26.2 Delta 3 — live read of whether the embedded webclient is
   *  actually servable at `/webclient/` on the public listener: a verified
   *  bundle loaded at boot AND `resolution.webclient.public` on the grid.
   *  Both are required — a redirect to `/webclient/` is only useful if that
   *  path serves (bundle present) AND is public (grid bit). Production wires
   *  `() => config.webclientBundle != null && (await machine.current())
   *  .resolution.webclient.public === true`. Absent / false → the apex
   *  `serve_webclient` mode 404s (no redirect-to-404). */
  getWebclientServable?: () => Promise<boolean> | boolean;
  /** Override the redirect target. Production wiring leaves this unset
   *  so the contract constant is the single source of truth; tests
   *  inject custom targets to assert the response carries the exact
   *  string they passed in. */
  target?: string;
  /** Override the Host-suffix matcher. Production wiring leaves this
   *  unset to use `isProDdnsHost`; tests inject a stub matcher to
   *  exercise the "host accepted" + "host rejected" branches without
   *  depending on the canonical `.recued.cloud` zone. */
  hostMatcher?: (host: string | undefined) => boolean;
  /** Optional structured logger. Receives one entry per dispatch
   *  decision. Diagnostic only; never affects behavior. */
  log?: (
    level: 'info' | 'warn',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/** D-148 FU#7 + R26.2 Delta 2 — factory for the apex (`GET /`) handler.
 *
 *  Production usage: `createRootApexHandler({ getApexMode, getReceptionPublic,
 *  receptionHandler })`. Wiring (`server.ts#createServerHandlerSet`) returns
 *  the handler in the `rootHandler` slot of `ServerHandlerSet`; the
 *  path-listener-set threads it onto the PUBLIC listener via
 *  `createPathRouter`. Reads the mode + gates per request so a config flip
 *  is hot. */
export const createRootApexHandler = (
  options: RootApexHandlerOptions = {},
): PortRequestHandler => {
  const target = options.target ?? ROOT_REDIRECT_TARGET;
  const matchHost = options.hostMatcher ?? isProDdnsHost;
  const getApexMode = options.getApexMode ?? (() => DEFAULT_ROOT_APEX_MODE);
  const log = options.log;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();

    if (!ALLOWED_METHODS.has(method)) {
      log?.('info', 'apex: 405 (method not allowed)', { method });
      respond405(res);
      return;
    }

    const mode = getApexMode();

    if (mode === 'not_found') {
      log?.('info', 'apex: 404 (not_found mode)', {});
      respond404(res);
      return;
    }

    if (mode === 'serve_reception') {
      // Defensive consistency gate — the picker normally blocks selecting
      // serve_reception while /reception is private, but the grid can be
      // toggled off afterward. A 404 keeps the apex indistinguishable from
      // a closed path rather than serving a broken surface.
      const receptionPublic = await Promise.resolve(options.getReceptionPublic?.());
      if (!options.receptionHandler || receptionPublic !== true) {
        log?.('info', 'apex: 404 (serve_reception unavailable)', {
          has_handler: options.receptionHandler !== undefined,
          reception_public: receptionPublic === true,
        });
        respond404(res);
        return;
      }
      // Codex R26.2 fold — HEAD must stay side-effect-free. Delegating a
      // HEAD into the reception singleton page path consumes the per-IP
      // visitor rate-limit + runs render work (crawlers / monitors HEAD
      // roots routinely). Answer HEAD here with a bare 200 that matches the
      // GET availability; only GET delegates into the page handler.
      if (method === 'HEAD') {
        log?.('info', 'apex: serve_reception HEAD (200, no delegate)', {});
        respond200Head(res);
        return;
      }
      log?.('info', 'apex: serve_reception (→ /reception)', {});
      // Rewrite to the bare reception intake page; the handler is
      // `/reception`-prefix-gated (any query is dropped — the apex is the
      // bare intake, not a deep link).
      req.url = '/reception';
      await options.receptionHandler(req, res);
      return;
    }

    if (mode === 'serve_webclient') {
      // Defensive consistency gate (mirrors serve_reception): the picker
      // requires `/webclient` public to select serve_webclient, but the grid
      // can be toggled off, or the bundle removed, afterward. Not servable →
      // 404 (apex indistinguishable from a closed path) rather than a 302 to
      // a `/webclient/` that 404s.
      const servable = await Promise.resolve(options.getWebclientServable?.());
      if (servable !== true) {
        log?.('info', 'apex: 404 (serve_webclient not servable)', {});
        respond404(res);
        return;
      }
      // Same-origin 302 → `/webclient/`. GET + HEAD both redirect (a redirect
      // is side-effect-free — no body, no rate-limit, no render — so no HEAD
      // special-case). The webclient bundle uses RELATIVE asset paths +
      // `scope:'./'`, so the browser must land on `/webclient/` (not bare `/`)
      // for `./webclient-main.js` + the service worker to resolve correctly.
      log?.('info', 'apex: 302 (→ /webclient/)', {});
      respond302(res, WEBCLIENT_PATH_PREFIX + '/');
      return;
    }

    // mode === 'redirect' (default).
    if (!matchHost(req.headers.host)) {
      // Generic 404 — matches the path-router's "unknown path" shape so
      // visitors hitting bare `/` on a BYO custom domain cannot
      // fingerprint that this server even runs the redirect surface.
      log?.('info', 'apex: 404 (host rejected)', { host: req.headers.host });
      respond404(res);
      return;
    }

    log?.('info', 'apex: 302', { target });
    respond302(res, target);
  };
};

export interface LanWebclientRootHandlerOptions {
  /** Live read of whether the embedded webclient is servable on the LAN
   *  listener: a verified bundle loaded at boot AND `resolution.webclient.lan`
   *  on the grid (LAN-on by default). Production wires
   *  `() => config.webclientBundle != null && (await machine.current())
   *  .resolution.webclient.lan === true`. Absent / false → bare `/` 404s
   *  (no redirect to a `/webclient/` that would itself 404). Mirrors the apex
   *  handler's `getWebclientServable`, but reads the LAN grid bit — the LAN
   *  root is not driven by `network.apex_mode` (that's a public-exposure
   *  choice); it is a fixed serve-my-own-webclient convenience. */
  getWebclientServable?: () => Promise<boolean> | boolean;
  /** Optional structured logger. Diagnostic only; never affects behavior. */
  log?: (
    level: 'info' | 'warn',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

/** Offline-pairing convenience — the LAN listener's bare (`GET /`) handler.
 *
 *  Where `createRootApexHandler` governs the PUBLIC bare `/` (redirect a
 *  stranger to app.recued.com, or serve reception / webclient per the
 *  owner's `network.apex_mode` exposure choice), THIS handler governs the
 *  LAN bare `/`. On the LAN listener the only visitor is the operator on
 *  their own machine, so the single useful behavior is: land them on the
 *  embedded webclient (`/webclient/`) to pair to their own server offline /
 *  in-house — no cloud round-trip, no `app.recued.com`.
 *
 *  Behavior (a deliberate subset of the apex `serve_webclient` mode):
 *    - non-GET/HEAD          → 405 (`Allow: GET, HEAD`)
 *    - GET/HEAD, servable    → 302 `Location: /webclient/`
 *    - GET/HEAD, not servable→ 404 (generic — indistinguishable from a
 *                              closed path; a source build with no bundle
 *                              still 404s here)
 *
 *  A redirect (not an inline serve) for the same reason the apex mode
 *  redirects: the bundle's assets are RELATIVE (`./webclient-main.js`) and
 *  the service worker is `scope:'./'`, so the document URL must be
 *  `/webclient/` for those to resolve. No host gate — the LAN listener's
 *  bind already scopes reachability (§ A.7.5); the visitor is the user. */
export const createLanWebclientRootHandler = (
  options: LanWebclientRootHandlerOptions = {},
): PortRequestHandler => {
  const log = options.log;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();

    if (!ALLOWED_METHODS.has(method)) {
      log?.('info', 'lan-root: 405 (method not allowed)', { method });
      respond405(res);
      return;
    }

    // Same defensive servability gate as the apex `serve_webclient` mode: a
    // 302 to `/webclient/` is only useful when that path actually serves on
    // this listener (verified bundle present AND `resolution.webclient.lan`).
    // Not servable → 404 rather than a redirect to a 404.
    const servable = await Promise.resolve(options.getWebclientServable?.());
    if (servable !== true) {
      log?.('info', 'lan-root: 404 (webclient not servable)', {});
      respond404(res);
      return;
    }

    // Same-origin 302 → `/webclient/`. GET + HEAD both redirect (side-effect-
    // free — no body, no rate-limit, no render).
    log?.('info', 'lan-root: 302 (→ /webclient/)', {});
    respond302(res, WEBCLIENT_PATH_PREFIX + '/');
  };
};

/** 302 with the exact redirect target — no interpolation of Host, path,
 *  query, or fragment. The response body is empty; `Content-Length: 0`
 *  set explicitly so intermediaries don't reach for `Transfer-Encoding`. */
const respond302 = (res: ServerResponse, target: string): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 302;
  res.setHeader('location', target);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', '0');
  res.end();
};

/** R26.2 Delta 2 — side-effect-free HEAD response for serve modes. Signals
 *  "content is served here" with headers only — no body, no delegation into
 *  the rate-limit-consuming page path. `Content-Length: 0` is explicit (the
 *  body is empty); `Cache-Control: no-store` since the apex resolves live. */
const respond200Head = (res: ServerResponse): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 200;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', '0');
  res.end();
};

/** Generic 404 — matches `path-router.ts#respond404` so the response
 *  body is indistinguishable from the dispatcher's unknown-path 404. */
const respond404 = (res: ServerResponse): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: { code: 'not_found' } }));
};

/** 405 method-not-allowed with `Allow` header per RFC 7231 § 6.5.5. */
const respond405 = (res: ServerResponse): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 405;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('allow', 'GET, HEAD');
  res.end(JSON.stringify({ error: { code: 'method_not_allowed' } }));
};
