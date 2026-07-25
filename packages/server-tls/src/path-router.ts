/** D-148 § A.6 — front-line path-routing dispatcher.
 *
 *  Replaces the per-port handler-per-listener model with a single
 *  dispatcher that fans inbound traffic to per-channel handlers based
 *  on URL path. The dispatcher sits in front of each of the two
 *  listeners (LAN port-80 plain HTTP + public port-443 TLS) and is the
 *  same code path on both — the only per-listener input is the
 *  `listener` bit it consults on the per-path resolution table.
 *
 *  Two ingress shapes route through the dispatcher:
 *  - **request/response** — wired to `server.on('request', router.request)`
 *  - **WebSocket upgrade** — wired to `server.on('upgrade', router.upgrade)`
 *
 *  Both share the same routing table; W3.4 wires both onto each listener
 *  so `/ws` real WS handshakes (which Node emits on the http server's
 *  `'upgrade'` event, NOT through the request pipeline) reach the WS
 *  role handler. Codex P1 #1 fold — without this, the WS role's
 *  primary admin channel would silently fail after W3.4.
 *
 *  Cross-channel isolation invariant (per `project_mcp_channel_invariant.md`
 *  + § A.6.2): both dispatchers route by exact path role; handlers are
 *  wired by role; one role's handler never sees another role's request
 *  or upgrade. Enforced at the routing table, not at the port number.
 *
 *  Fingerprint discipline (§ A.6): unknown paths and paths disabled per
 *  the per-listener resolution bit return the same generic 404 shape on
 *  both surfaces — JSON `{ "error": { "code": "not_found" } }` for the
 *  request side; raw `HTTP/1.1 404 Not Found` + `Connection: close` for
 *  the upgrade side. Body never echoes role names or any handler-
 *  specific hint.
 *
 *  W3.4 (listener-set rewire) consumes this dispatcher: each of the two
 *  listeners builds a `createPathRouter({ resolution, handlers, listener })`
 *  + wires both `router.request` + `router.upgrade`. The dispatcher
 *  itself does no auth, no rate-limit, no audit — those are per-handler
 *  concerns per § A.6.2. The dispatcher's only job is "which role does
 *  this URL belong to, is it enabled on this listener bit, is the role
 *  handler wired?". */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  PATH_ROLES,
  matchesPathRole,
  type PathResolution,
  type PathRole,
} from '@recued/contracts';
import type { PortRequestHandler, PortUpgradeHandler } from './types.js';

/** Which of the two listeners is invoking the dispatcher. The dispatcher
 *  reads `resolution[role][listener]` to decide whether the path is
 *  served here; the same `resolution` table feeds both listeners. */
export type PathRouterListener = 'lan' | 'public';

/** D-148 W3.5b — legacy path alias entry.
 *
 *  Pre-launch zero-installs (per `feedback_pre_launch_no_migration`) lets
 *  us retire surfaces outright, but the W3.5b slice scopes to *production
 *  wiring migration* — renaming every existing path under canonical role
 *  prefixes would cascade through ~30 test + provider files and bloat the
 *  slice beyond "bin.ts caller migration." Closed-list alias map gives
 *  the path-router a deterministic mapping from existing path strings
 *  (`/auth/pair`, `/status`, `/status.json`, `/webhook/<slug>`,
 *  `/hook/<recipe>/<slug>`, `/v1/connection/webhook/<vendor>/<conn>`) to
 *  the appropriate role.
 *
 *  Each alias declares an `exact` path match OR a `prefix` match (the
 *  prefix variant requires the trailing slash for `/`-boundary discipline
 *  — same as `matchesPathRole`). The dispatcher walks aliases BEFORE the
 *  canonical role match; the canonical match always wins when both could
 *  apply.
 *
 *  Channel-isolation invariant (per `project_mcp_channel_invariant.md`):
 *  each legacy path maps to exactly one role; the alias map is closed-
 *  list at construction time and immutable for the listener's lifetime.
 *  A future slice (W3.6+) retires the aliases by renaming paths to
 *  canonical + updating tests/provider docs in one cascading sweep. */
export type PathRouterLegacyAlias =
  | { kind: 'exact'; path: string; role: PathRole }
  | { kind: 'prefix'; prefix: string; role: PathRole };

export interface PathRouterOptions {
  /** Per-path resolution table from the ExposureState. Source of truth
   *  for which listener serves which path. */
  resolution: Record<PathRole, PathResolution>;
  /** Per-role request handler map. A role may be omitted — the
   *  dispatcher returns the generic 404 in that case (no fingerprint
   *  leak). */
  handlers: Partial<Record<PathRole, PortRequestHandler>>;
  /** Per-role upgrade handler map. Real WebSocket handshakes for the
   *  `/ws` role arrive on the http server's `'upgrade'` event; this
   *  map dispatches them by path role exactly like the request map.
   *  Roles that don't accept upgrades (everything except `ws` today)
   *  leave their slot undefined — an upgrade hitting a role with no
   *  handler closes the socket with a generic 404 line. */
  upgradeHandlers?: Partial<Record<PathRole, PortUpgradeHandler>>;
  /** D-148 W3.5b — optional legacy alias table. Empty / unset → only
   *  canonical role prefixes dispatch. Set by the production listener
   *  wiring (`bin.ts`) to preserve existing path shapes during the
   *  amendment rollout; tests of the router itself leave it unset to
   *  exercise the canonical surface. Aliases are walked in array order
   *  on each request + upgrade; first match wins. */
  legacyAliases?: ReadonlyArray<PathRouterLegacyAlias>;
  /** D-148 follow-up #7 — bare root (`/`) request handler. Threaded by
   *  the listener-set onto the PUBLIC listener only — visitors hitting
   *  `https://<handle>.recued.cloud/` need somewhere to land; LAN bare
   *  `/` keeps the generic 404 (LAN visitors are the user themselves;
   *  no stranger to redirect). Invoked BEFORE the role + alias lookup
   *  for exact `path === '/'` matches; sub-paths and role bases fall
   *  through to the regular dispatch chain unchanged. Upgrade-side bare
   *  `/` continues to reject — the root surface is a request-only
   *  redirect endpoint, not a WS handshake target.
   *
   *  When unset, the dispatcher 404s on bare `/` as today. The
   *  production wiring (bin.ts) supplies this for the public listener;
   *  the test-side `startServer` shim and substrate tests leave it
   *  unset to exercise the role surface. */
  rootHandler?: PortRequestHandler;
  /** Offline-pairing convenience — bare root (`/`) request handler for the
   *  LAN listener ONLY. Symmetric to `rootHandler` but the opposite listener:
   *  where `rootHandler` redirects a public visitor to app.recued.com, this
   *  lands the operator on their own machine's embedded webclient
   *  (`/webclient/`) so they can pair offline / in-house without a cloud
   *  round-trip. The listener-set threads it onto the LAN router only;
   *  invoked BEFORE role + alias lookup for exact `path === '/'` matches on
   *  the LAN bit, and never on the public bit (a public bare `/` keeps the
   *  `rootHandler` redirect). Sub-paths + role bases fall through unchanged;
   *  the upgrade side keeps rejecting bare `/`. Unset → LAN bare `/` 404s as
   *  today (the common case — production wires it only when a verified
   *  webclient bundle is present). */
  lanRootHandler?: PortRequestHandler;
  /** Which listener bit the dispatcher consults. */
  listener: PathRouterListener;
  /** Optional structured logger. Receives one entry per dispatch
   *  decision (`dispatched` / `not_found_unknown` / `not_found_disabled`
   *  / `not_found_unwired`). Diagnostic only — never affects routing. */
  log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface PathRouter {
  /** http(s) `'request'` handler — wired via `server.on('request', request)`.
   *  Identical shape to a per-port handler so the listener layer can
   *  treat it as a drop-in. */
  request: PortRequestHandler;
  /** http(s) `'upgrade'` handler — wired via `server.on('upgrade', upgrade)`.
   *  Routes WebSocket-upgrade requests by URL path. Failed routes
   *  respond with a raw HTTP/1.1 404 line + close the socket (the
   *  upgrade never enters the WebSocket protocol). */
  upgrade: PortUpgradeHandler;
}

/** Build the dispatcher. Returns both a request handler and an upgrade
 *  handler that share the same routing table. Safe to wire into both
 *  http and https listeners — never reaches into listener-layer state. */
export const createPathRouter = (options: PathRouterOptions): PathRouter => {
  const { resolution, handlers, upgradeHandlers, legacyAliases, rootHandler, lanRootHandler, listener, log } = options;

  /** Resolve a path to its role. Canonical role base wins; legacy alias
   *  table is consulted only when no canonical role matches. The alias
   *  map is empty/unset on the substrate's own tests so the canonical
   *  surface is exercised. */
  const resolveRole = (path: string): PathRole | null => {
    const canonical = findMatchingRole(path);
    if (canonical) return canonical;
    if (!legacyAliases) return null;
    for (const alias of legacyAliases) {
      if (alias.kind === 'exact') {
        if (path === alias.path) return alias.role;
      } else {
        if (path === alias.prefix.replace(/\/$/, '')) return alias.role;
        if (path.startsWith(alias.prefix)) return alias.role;
      }
    }
    return null;
  };

  const request: PortRequestHandler = (req: IncomingMessage, res: ServerResponse): void | Promise<void> => {
    const path = extractPath(req.url);

    // D-148 FU#7 — bare-root redirect carve-out. Public listener only:
    // when `path === '/'` AND a `rootHandler` is wired, dispatch to it
    // BEFORE the role lookup. Any other path (including role bases like
    // `/health` and sub-paths) flows through the regular role + alias
    // resolution chain unchanged. The LAN listener intentionally has no
    // root handler wired (the listener-set only threads it onto the
    // public listener), so LAN bare `/` keeps 404'ing.
    if (path === '/' && rootHandler && listener === 'public') {
      log?.('info', 'path-router: root handler dispatched', { listener });
      return rootHandler(req, res);
    }

    // Offline-pairing convenience — the mirror of the public carve-out above,
    // LAN-scoped: when `path === '/'` on the LAN listener AND a `lanRootHandler`
    // is wired, dispatch to it (production supplies a "land on `/webclient/`"
    // redirect so the operator can pair to their own server offline). Gated
    // `listener === 'lan'` so a public bare `/` never reaches it — the public
    // root stays the app.recued.com redirect. Any other path flows through the
    // regular role + alias chain unchanged.
    if (path === '/' && lanRootHandler && listener === 'lan') {
      log?.('info', 'path-router: lan root handler dispatched', { listener });
      return lanRootHandler(req, res);
    }

    // R26.2 Delta 3 — `/webclient/*` is a first-class path role (base
    // `/webclient`), no longer a LAN-only carve-out. It flows through the
    // regular role + resolution chain below: `resolveRole` maps it to the
    // `webclient` role, the per-listener `resolution.webclient` bit gates
    // serving (LAN-on / public-off by default), and `handlers.webclient`
    // (the bundle handler, present only when a verified bundle loaded at
    // boot) does the static-file dispatch. Absent handler → generic 404.
    const role = resolveRole(path);

    if (!role) {
      log?.('info', 'path-router: 404 (unknown path)', { path, listener });
      respond404(res);
      return;
    }

    if (!resolution[role][listener]) {
      log?.('info', 'path-router: 404 (path disabled on listener)', { path, role, listener });
      respond404(res);
      return;
    }

    const handler = handlers[role];
    if (!handler) {
      log?.('warn', 'path-router: 404 (handler missing for role)', { path, role, listener });
      respond404(res);
      return;
    }

    return handler(req, res);
  };

  const upgrade: PortUpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const path = extractPath(req.url);
    const role = resolveRole(path);

    if (!role) {
      log?.('info', 'path-router: upgrade 404 (unknown path)', { path, listener });
      rejectUpgrade(socket);
      return;
    }

    if (!resolution[role][listener]) {
      log?.('info', 'path-router: upgrade 404 (path disabled on listener)', { path, role, listener });
      rejectUpgrade(socket);
      return;
    }

    const handler = upgradeHandlers?.[role];
    if (!handler) {
      // No upgrade handler wired for this role — e.g., upgrade attempt
      // against `/mcp` or `/health` where the role doesn't speak the
      // WS protocol. Same generic 404 as unknown-path so the listener
      // doesn't fingerprint which roles accept upgrades.
      log?.('warn', 'path-router: upgrade 404 (upgrade handler missing for role)', {
        path,
        role,
        listener,
      });
      rejectUpgrade(socket);
      return;
    }

    handler(req, socket, head);
  };

  return { request, upgrade };
};

/** Strip query string + fragment from a raw request URL. Node's
 *  IncomingMessage.url is the path-and-query-string; HTTP fragments
 *  should not survive to the server, but defensively strip them too. */
const extractPath = (rawUrl: string | undefined): string => {
  if (!rawUrl) return '';
  const queryIdx = rawUrl.indexOf('?');
  const hashIdx = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (queryIdx >= 0) end = Math.min(end, queryIdx);
  if (hashIdx >= 0) end = Math.min(end, hashIdx);
  return rawUrl.slice(0, end);
};

/** Find the unique role whose canonical base claims this URL. Iterates
 *  in `PATH_ROLES` order; first match wins. The W3.1 path-role base set
 *  is mutually exclusive (no base is a `/`-bounded prefix of another),
 *  so at most one role can match — the deterministic iteration order is
 *  belt-and-braces. */
const findMatchingRole = (path: string): PathRole | null => {
  for (const role of PATH_ROLES) {
    if (matchesPathRole(path, role)) return role;
  }
  return null;
};

/** Vendor-agnostic 404 on the request side. Body is identical across
 *  "unknown path", "disabled on this listener", and "handler unwired"
 *  cases — callers cannot fingerprint which case fired. Idempotent
 *  against an already-sent response (defensive against handlers that
 *  respond and then re-enter the dispatcher; shouldn't happen but cheap
 *  to guard). */
const respond404 = (res: ServerResponse): void => {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: { code: 'not_found' } }));
};

/** Vendor-agnostic 404 on the upgrade side. Real WS upgrades arrive on
 *  the http server's `'upgrade'` event with a raw socket + head buffer
 *  (NOT through the request/response pipeline). The dispatcher writes a
 *  minimal HTTP/1.1 status line + closes the socket — the upgrade never
 *  enters the WebSocket protocol. Mirrors the convention from
 *  `backend/server/src/ports/ws/handler.ts#writeRawHttpResponse`. */
const rejectUpgrade = (socket: Socket): void => {
  const response = [
    'HTTP/1.1 404 Not Found',
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  try {
    socket.write(response);
  } catch {
    // Socket already closed — nothing to do.
  } finally {
    try { socket.destroy(); } catch { /* already destroyed */ }
  }
};
