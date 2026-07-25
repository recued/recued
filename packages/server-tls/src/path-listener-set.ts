/** D-148 § A.6 + § A.6.1 — two-listener path-routed orchestrator (W3.4).
 *
 *  Replaces the per-port `createListenerSet` with a per-listener flow
 *  that binds two listeners (LAN port 80 plain HTTP + public port 443
 *  TLS) and fronts both with a `createPathRouter` dispatcher. The
 *  routing table is per-path (via `PathResolution { lan; public }` from
 *  the ExposureState); each listener consults its own bit to decide
 *  whether a path is served on it.
 *
 *  W3.4 ships the substrate alongside the legacy per-port factory; the
 *  legacy `createListenerSet` stays in place and existing tests pass
 *  unchanged. The ExposureState rewires + caller migration land in W3.5;
 *  multi-domain SNI production wiring lands in W3.6. Until then this
 *  factory still uses the single-cert `CertChainHolder` (one cert covers
 *  every domain) — the SNICallback reads through the holder identically
 *  to the legacy flow.
 *
 *  Listener bind rule per § A.6.1:
 *
 *  ```
 *  LAN listener (plain HTTP, port 80 by default):
 *    bind iff anyPathLan(resolution)
 *  Public listener (TLS, port 443 by default; plaintext if no cert):
 *    bind iff anyPathPublic(resolution)
 *  ```
 *
 *  Both listeners can bind simultaneously (typical non-maintenance
 *  config). `maintenance` preset binds neither. Failure handling per
 *  § P6 risk row carries forward: a listener whose `listen()` rejects
 *  is logged + kept out of the active set; the start does NOT fail —
 *  the Reachability Doctor surfaces the failure per listener.
 *
 *  Cross-listener isolation: each listener builds its own router with
 *  its own `listener` bit, so a path enabled only on the LAN bit
 *  returns 404 (no fingerprint) on the public listener and vice versa.
 *  Enforced at the routing table — not at the port number — which keeps
 *  the channel isolation invariant (`project_mcp_channel_invariant.md`)
 *  intact through path consolidation. */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import {
  anyPathLan,
  anyPathPublic,
  PATH_ROLES,
  type HostnameCertSource,
  type HostnameTlsTopology,
  type PathResolution,
  type PathRole,
  type TLSDomainCertChain,
  type TLSDomainCertSource,
} from '@recued/contracts';
import type { CertChainHolder } from './cert-chain.js';
import {
  createPathRouter,
  type PathRouterLegacyAlias,
  type PathRouterListener,
} from './path-router.js';
import type {
  ListenerFailureReason,
  PortRequestHandler,
  PortUpgradeHandler,
} from './types.js';

/** Spec default ports per § A.6 — standard ports universally pass
 *  through firewalls / NAT / corporate proxies / mobile carriers /
 *  tunnel vendors. Tests / dev override to OS-picked port 0. */
export const DEFAULT_LAN_PORT = 80 as const;
export const DEFAULT_PUBLIC_PORT = 443 as const;

/** Default bind address for the LAN listener — `'127.0.0.1'` loopback.
 *
 *  Per spec § A.7.5: "Default LAN bind for port 80 = the primary local
 *  interface IP (e.g., `192.168.1.42`); user can override in Settings →
 *  Server → Network. `127.0.0.1` for 'this machine only' mode (rare,
 *  but useful for dev)." Resolving the primary LAN interface IP is a
 *  runtime concern (`os.networkInterfaces()` + the user's override
 *  from Settings → Server → Network); the substrate cannot do it
 *  decoupled from that runtime state.
 *
 *  This substrate ships the **conservative fallback** so a caller that
 *  forgets to pass a resolved LAN address cannot accidentally over-
 *  expose LAN-only paths (`/ws`, `/mcp`, `/health` under `lan_only`
 *  preset) to every routable interface including WAN / VPN / tunnel
 *  interfaces. Production wiring in W3.5 (bin.ts caller) MUST resolve
 *  the detected LAN IP per § A.7.5 and pass it explicitly via
 *  `lan_bind_address`; using this default in production silently
 *  shrinks reachability to the host alone, which the Reachability
 *  Doctor surfaces. Codex W3.4 P1 fold — original default was the
 *  `'0.0.0.0'` wildcard, which would have bound LAN-only paths on
 *  every interface and broken the LAN/public boundary § A.7.5
 *  encodes. */
export const DEFAULT_LAN_BIND_ADDRESS = '127.0.0.1' as const;
/** Default bind address for the public listener — `'0.0.0.0'` wildcard
 *  so the listener accepts WAN traffic post-port-forward / tunnel.
 *  Spec-aligned per § A.7.5. The per-path resolution table filters
 *  what the public listener actually serves; the wildcard bind is
 *  necessary because the public hostname's DNS A record terminates
 *  on whatever interface the upstream firewall forwards 443 to. */
export const DEFAULT_PUBLIC_BIND_ADDRESS = '0.0.0.0' as const;

export interface HostnameSniBinding {
  hostname: string;
  cert_source: HostnameCertSource;
  tls_topology: HostnameTlsTopology;
}

export type HostnameSniBindingLookup = (servername: string) => HostnameSniBinding | null;

export type SniCertDispatchFailureReason =
  | 'tls_sni_required'
  | 'tls_hostname_unverified'
  | 'tls_topology_not_server_terminated'
  | 'tls_domain_lookup_required'
  | 'tls_domain_unknown'
  | 'tls_cert_source_mismatch';

export type SniCertDispatchResult =
  | { ok: true; entry: TLSDomainCertChain }
  | { ok: false; reason: SniCertDispatchFailureReason };

export const tlsDomainSourceForHostnameCertSource = (
  source: HostnameCertSource,
): TLSDomainCertSource | null => {
  if (source === 'recued_acme') return 'pro_acme';
  if (source === 'byo_uploaded') return 'byo_upload';
  return null;
};

export const selectSniCertChain = (options: {
  servername: string;
  hostname_binding_lookup?: HostnameSniBindingLookup;
  tls_domain_lookup?: (servername: string) => TLSDomainCertChain | null;
}): SniCertDispatchResult => {
  const { servername, hostname_binding_lookup, tls_domain_lookup } = options;
  if (!servername) return { ok: false, reason: 'tls_sni_required' };

  if (hostname_binding_lookup) {
    const binding = hostname_binding_lookup(servername);
    if (!binding) return { ok: false, reason: 'tls_hostname_unverified' };
    if (binding.tls_topology !== 'server_terminated') {
      return { ok: false, reason: 'tls_topology_not_server_terminated' };
    }
    if (!tls_domain_lookup) return { ok: false, reason: 'tls_domain_lookup_required' };

    const expectedSource = tlsDomainSourceForHostnameCertSource(binding.cert_source);
    if (!expectedSource) return { ok: false, reason: 'tls_topology_not_server_terminated' };

    const entry = tls_domain_lookup(binding.hostname || servername);
    if (!entry || !entry.cert_pem || !entry.private_key_pem) {
      return { ok: false, reason: 'tls_domain_unknown' };
    }
    if (entry.source !== expectedSource) {
      return { ok: false, reason: 'tls_cert_source_mismatch' };
    }
    return { ok: true, entry };
  }

  if (!tls_domain_lookup) return { ok: false, reason: 'tls_domain_lookup_required' };
  const entry = tls_domain_lookup(servername);
  if (!entry || !entry.cert_pem || !entry.private_key_pem) {
    return { ok: false, reason: 'tls_domain_unknown' };
  }
  return { ok: true, entry };
};

export interface PathListenerSetOptions {
  /** Per-path resolution table from the ExposureState. The source of
   *  truth for which listener serves which path; each listener consults
   *  its own bit on each per-role entry. */
  resolution: Record<PathRole, PathResolution>;
  /** Per-role request handler map. Roles whose handler is omitted yield
   *  a generic 404 from the dispatcher (no fingerprint of which roles
   *  are wired). */
  handlers: Partial<Record<PathRole, PortRequestHandler>>;
  /** Per-role upgrade handler map. The `ws` role's real WebSocket
   *  handshake arrives via `server.on('upgrade', ...)` — this map
   *  routes upgrades by path role exactly like the request map. Roles
   *  whose upgrade handler is omitted yield a raw HTTP/1.1 404 +
   *  socket close from the dispatcher. */
  upgradeHandlers?: Partial<Record<PathRole, PortUpgradeHandler>>;
  /** D-148 W3.5b — optional legacy alias map. Threaded into both
   *  listeners' `createPathRouter` calls so existing path shapes
   *  (`/auth/pair`, `/status*`, `/webhook/*`, `/v1/connection/webhook/*`,
   *  `/hook/*`) keep dispatching to the
   *  appropriate role while the W3.5b production migration lands.
   *  Substrate tests leave this unset. */
  legacyAliases?: ReadonlyArray<PathRouterLegacyAlias>;
  /** D-148 follow-up #7 — bare-root request handler. Threaded ONLY
   *  onto the public listener; the LAN listener never sees it. When
   *  set, the public dispatcher invokes this for exact `path === '/'`
   *  requests ahead of role lookup. Production wiring supplies the
   *  bare-302 redirect handler that responds with HTTP 302 +
   *  `Location: https://app.recued.com/` for `<handle>.recued.cloud`
   *  Host headers, and a generic 404 for anything else (BYO custom
   *  domain, bare apex, multi-label subdomain). Unset → public-listener
   *  bare `/` 404s as today. */
  rootHandler?: PortRequestHandler;
  /** Offline-pairing convenience — bare-root (`/`) handler threaded ONLY
   *  onto the LAN listener (the mirror of `rootHandler`, which is public-
   *  only). Production supplies a handler that 302-redirects the operator's
   *  bare LAN `/` to the embedded webclient at `/webclient/` when a verified
   *  bundle is present, so a self-hoster can pair to their own server
   *  offline. Unset → LAN bare `/` 404s as today. */
  lanRootHandler?: PortRequestHandler;
  /** Shared cert holder. When `current() === null` the public listener
   *  binds plaintext (the upstream proxy holds the cert in `certbot` /
   *  `caddy` modes); when set, the public listener wraps `https` with
   *  `SNICallback` reading through the holder so rotation is a pointer
   *  swap with no re-bind. Multi-domain SNI lands in W3.6 — this slot
   *  still serves as the per-listener bind discriminator (TLS vs.
   *  plaintext) AND as the bootstrap cert that
   *  `tls.createServer(options.cert)` requires before the
   *  per-handshake `SNICallback` can swap the right cert in. */
  cert_chain: CertChainHolder;
  /** D-148 W3.6 — optional per-handshake `SNICallback` lookup. When
   *  provided, the public listener routes every TLS handshake through
   *  `lookup(servername)` for per-domain cert dispatch. Unknown
   *  ServerName → connection close (the SNICallback signals the
   *  failure rather than serving the bootstrap cert with a mismatch
   *  warning). When omitted, the listener falls back to single-cert
   *  flow (legacy behavior reading through `cert_chain`).
   *
   *  The lookup must be SYNCHRONOUS — Node's `SNICallback` runs at
   *  handshake time on the I/O thread; an async path would force every
   *  handshake to bounce through the event loop. The W3.6 SQLite-
   *  backed store warms its decrypted-private-key cache at boot so
   *  the per-handshake lookup is a single SQLite point query + a
   *  Map.get(). */
  tls_domain_lookup?: (servername: string) => TLSDomainCertChain | null;
  /** D-152 P0 — optional multi-hostname registry gate. When supplied,
   *  every TLS handshake first reads the hostname registry binding for
   *  the ClientHello ServerName. Only enabled + ownership-verified +
   *  `server_terminated` hostnames may continue to the per-domain cert
   *  lookup. The resulting hostname cert source is also checked against
   *  the `tls_domains` row source (`recued_acme`→`pro_acme`,
   *  `byo_uploaded`→`byo_upload`) so a verified hostname cannot serve a
   *  cert from the wrong provenance. Unknown / pending / upstream-
   *  terminated hostnames close the TLS handshake instead of falling
   *  through to the bootstrap cert. */
  hostname_binding_lookup?: HostnameSniBindingLookup;
  /** Port for the LAN listener. Defaults to standard port 80. Pass 0
   *  in tests so the OS picks a free port. */
  lan_port?: number;
  /** Bind address for the LAN listener. Production callers (W3.5
   *  bin.ts) MUST pass the detected primary LAN-routable interface IP
   *  per § A.7.5 (e.g., `'192.168.1.42'`); otherwise LAN-only paths
   *  are reachable only from the host itself. Defaults to
   *  `DEFAULT_LAN_BIND_ADDRESS` (`'127.0.0.1'` — the safe fallback)
   *  rather than the `'0.0.0.0'` wildcard so a forgotten override
   *  cannot over-expose LAN-only paths to WAN / VPN / tunnel
   *  interfaces. */
  lan_bind_address?: string;
  /** Port for the public listener. Defaults to standard port 443. */
  public_port?: number;
  /** Bind address for the public listener. Defaults to `'0.0.0.0'`
   *  (`DEFAULT_PUBLIC_BIND_ADDRESS`) so it accepts WAN traffic post-
   *  port-forward / tunnel. The per-path resolution table filters
   *  what the public listener serves; the bind is intentionally
   *  wildcard so the public hostname's DNS A record terminates on
   *  whatever interface the upstream firewall forwards 443 to. */
  public_bind_address?: string;
  /** Optional structured logger. Receives one entry per lifecycle
   *  transition (bind / unbind / failure) + per-handler failure. The
   *  dispatcher's own diagnostic logs flow through the same callback. */
  log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface PathListenerStatus {
  /** Which listener this row describes. */
  listener: PathRouterListener;
  /** Resolved bound port (request port 0 yields the OS-picked port). */
  port: number;
  /** True iff the listener is actively bound. False when the listener
   *  was elected off (no path enabled for this listener's bit) OR when
   *  bind failed. */
  listening: boolean;
  /** The interface the listener bound to. Null when not bound. */
  bind_address: string | null;
  /** True iff the listener wrapped `https` (cert present). False for
   *  plaintext binds (LAN listener always; public listener when the
   *  cert holder is empty). */
  tls: boolean;
  /** Closed-list failure reason when `listening === false` and the
   *  listener was supposed to bind (i.e., at least one path enabled
   *  for the listener's bit). Surfaces in the Reachability Doctor. */
  failure?: ListenerFailureReason;
}

export interface PathListenerSet {
  /** Start both listeners (the ones whose bind rule says they should
   *  serve). Listeners that fail to bind are recorded under `failure`
   *  but don't reject the promise. */
  start(): Promise<PathListenerStatus[]>;
  /** D-148 exposure-flip robustness — apply a new per-path resolution to
   *  the ALREADY-RUNNING set WITHOUT tearing down listeners that stay up.
   *
   *  The dispatcher reads `resolution[role][listener]` live on every
   *  request/upgrade, so a routing change (e.g., reception toggled on for
   *  LAN) takes effect by mutating the shared resolution in place — no
   *  router rebuild, no listening-socket close. Only a listener whose
   *  bind decision actually flips is touched: off→on binds a fresh
   *  listener, on→off force-closes the retired one (its connections are
   *  intentionally going away). A listener that stays up (the common case
   *  for a path content-flip) is left exactly as-is — which is what keeps
   *  a live control WS from wedging the rebind via a `server.close()` that
   *  blocks forever on the never-draining upgraded socket. */
  applyResolution(next: Record<PathRole, PathResolution>): Promise<PathListenerStatus[]>;
  /** Stop every active listener. Pending requests drain; a hard
   *  deadline is the caller's responsibility (§ A.6.6 calls out the
   *  30s window on the WS path specifically). */
  stop(): Promise<void>;
  /** Per-listener status snapshot. Reads in-memory state — no IO. */
  status(): PathListenerStatus[];
}

const LAN_LISTENER: PathRouterListener = 'lan';
const PUBLIC_LISTENER: PathRouterListener = 'public';

/** Reduce a Node `listen()` error to one of the closed-list failure
 *  reasons. The Reachability Doctor maps each reason to a remediation
 *  hint. Same taxonomy as legacy listener-set so the doctor's renderer
 *  doesn't need to special-case the path-routed flow. */
const classifyListenError = (err: unknown): ListenerFailureReason => {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === 'EADDRINUSE') return 'port_in_use';
  if (code === 'EACCES') return 'permission_denied';
  if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND' || code === 'EAFNOSUPPORT') return 'address_unreachable';
  return 'unknown';
};

interface ActivePathListener {
  listener: PathRouterListener;
  server: HttpServer | HttpsServer;
  bind_address: string;
  port: number;
  tls: boolean;
  /** Live sockets on this listener, tracked via the server's `connection`
   *  event. Needed for a FORCED close: Node's `server.close()` blocks on
   *  any open connection and `closeAllConnections()` does NOT drop an
   *  upgraded (WebSocket) socket — so an electively-retired listener
   *  destroys these directly to release the bind. */
  sockets: Set<Socket>;
}

/** Build the two-listener orchestrator. The set is dormant until
 *  `.start()` — listener servers are constructed at start time, not at
 *  factory time, so a `cert_chain.rotate(...)` between factory and start
 *  is observed by the public listener's initial bind. */
export const createPathListenerSet = (options: PathListenerSetOptions): PathListenerSet => {
  const {
    resolution,
    handlers,
    upgradeHandlers,
    legacyAliases,
    rootHandler,
    lanRootHandler,
    cert_chain,
    tls_domain_lookup,
    hostname_binding_lookup,
    lan_port = DEFAULT_LAN_PORT,
    lan_bind_address = DEFAULT_LAN_BIND_ADDRESS,
    public_port = DEFAULT_PUBLIC_PORT,
    public_bind_address = DEFAULT_PUBLIC_BIND_ADDRESS,
    log,
  } = options;

  const active = new Map<PathRouterListener, ActivePathListener>();
  const failures = new Map<PathRouterListener, ListenerFailureReason>();

  /** Wrap the dispatcher so a handler-returned rejected promise lands
   *  a controlled 500 response + log instead of bubbling to the
   *  process as an unhandled rejection. Mirrors the same fold the
   *  legacy listener-set received (Codex P1 #2 there) — modern Node
   *  can terminate the server on `Promise<void>` rejections. */
  const safeDispatch = (
    requestHandler: PortRequestHandler,
    listener: PathRouterListener,
  ): ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) => {
    return (req, res) => {
      let result: void | Promise<void>;
      try {
        result = requestHandler(req, res);
      } catch (err) {
        respondToHandlerFailure(res, err, listener);
        return;
      }
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => respondToHandlerFailure(res, err, listener));
      }
    };
  };

  const respondToHandlerFailure = (
    res: import('node:http').ServerResponse,
    err: unknown,
    listener: PathRouterListener,
  ): void => {
    log?.('error', 'path listener handler failed', {
      listener,
      error: err instanceof Error ? err.message : String(err),
    });
    if (res.writableEnded || res.headersSent) {
      try { res.end(); } catch { /* socket already closed */ }
      return;
    }
    try {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'internal_error' } }));
    } catch { /* socket already closed */ }
  };

  const buildLanServer = (): HttpServer => {
    const router = createPathRouter({
      resolution,
      handlers,
      upgradeHandlers,
      ...(legacyAliases ? { legacyAliases } : {}),
      // Offline-pairing convenience — the LAN-only bare-`/` handler. Threading
      // it here (not into `buildPublicServer`) is the structural mirror of the
      // public `rootHandler`: LAN bare `/` lands the operator on their own
      // embedded webclient; the public bare `/` redirects a stranger to
      // app.recued.com.
      ...(lanRootHandler ? { lanRootHandler } : {}),
      listener: LAN_LISTENER,
      log,
    });
    const httpServer = createHttpServer(safeDispatch(router.request, LAN_LISTENER));
    httpServer.on('upgrade', router.upgrade);
    return httpServer;
  };

  const buildPublicServer = (): { server: HttpServer | HttpsServer; tls: boolean } => {
    const router = createPathRouter({
      resolution,
      handlers,
      upgradeHandlers,
      ...(legacyAliases ? { legacyAliases } : {}),
      // D-148 FU#7 — root handler is public-only. Threading it here
      // (not into the LAN router below) is the structural enforcement
      // of "LAN visitors are the user themselves; no stranger to
      // redirect to app.recued.com".
      ...(rootHandler ? { rootHandler } : {}),
      listener: PUBLIC_LISTENER,
      log,
    });
    const chain = cert_chain.current();
    if (chain && chain.cert_pem && chain.private_key_pem) {
      // HTTPS via SNICallback so rotation propagates through the holder
      // (single-cert) OR the per-handshake `tls_domain_lookup` (W3.6
      // multi-domain) without a re-bind. The bootstrap `cert` + `key`
      // options remain set to the holder's current chain — Node
      // requires a default secure context at server creation time, even
      // when SNICallback overrides per-handshake. The bootstrap cert
      // is only served when SNICallback returns null without an error
      // AND the SNI lookup found nothing — which is exactly the path
      // we close cleanly when `tls_domain_lookup` is wired (per § A.6.3
      // "unknown ServerName → connection close — safer than serving
      // the default cert with a mismatch warning").
      const httpsServer = createHttpsServer(
        {
          SNICallback: (servername, cb) => {
            // W3.6 multi-domain dispatch — when the production wiring
            // supplies a `tls_domain_lookup`, route the per-handshake
            // ServerName through it for per-domain cert resolution.
            // Unknown domain → close the connection by signalling an
            // error to the callback (Node's TLS layer aborts the
            // handshake without serving the bootstrap cert).
            if (tls_domain_lookup || hostname_binding_lookup) {
              const selected = selectSniCertChain({
                servername,
                ...(hostname_binding_lookup ? { hostname_binding_lookup } : {}),
                ...(tls_domain_lookup ? { tls_domain_lookup } : {}),
              });
              if (!selected.ok) {
                cb(new Error(selected.reason));
                return;
              }
              try {
                // Lazy-import keeps node:tls out of the substrate's
                // top-level imports — it's only loaded when at least
                // one TLS handshake fires.
                import('node:tls').then(({ createSecureContext }) => {
                  // Codex W3.6 P1 #3 fold — intermediates MUST be
                  // concatenated into the `cert` value, NOT placed in
                  // `ca`. `ca` configures trusted CAs for **client**
                  // cert verification; the server's chain sent to
                  // browsers comes from `cert`. Concatenating the
                  // leaf + chain into `cert` is the canonical
                  // multi-PEM pattern for `tls.createSecureContext`.
                  const certBundle = selected.entry.chain_pem
                    ? `${selected.entry.cert_pem}\n${selected.entry.chain_pem}`
                    : selected.entry.cert_pem;
                  cb(
                    null,
                    createSecureContext({
                      cert: certBundle,
                      key: selected.entry.private_key_pem,
                    }),
                  );
                }).catch((err) => cb(err as Error));
              } catch (err) {
                cb(err as Error);
              }
              return;
            }
            // Legacy single-cert flow — read through the holder so
            // rotation propagates without a re-bind. Used by tests +
            // pre-W3.6 dev configs.
            const c = cert_chain.current();
            if (!c || !c.cert_pem || !c.private_key_pem) {
              cb(new Error('tls_cert_unavailable'));
              return;
            }
            try {
              import('node:tls').then(({ createSecureContext }) => {
                cb(null, createSecureContext({ cert: c.cert_pem, key: c.private_key_pem }));
              }).catch((err) => cb(err as Error));
            } catch (err) {
              cb(err as Error);
            }
          },
          cert: chain.cert_pem,
          key: chain.private_key_pem,
        },
        safeDispatch(router.request, PUBLIC_LISTENER),
      );
      httpsServer.on('upgrade', router.upgrade);
      return { server: httpsServer, tls: true };
    }
    // No cert loaded — upstream-TLS modes (certbot / caddy) terminate
    // at the reverse proxy; the public listener binds plaintext.
    const httpServer = createHttpServer(safeDispatch(router.request, PUBLIC_LISTENER));
    httpServer.on('upgrade', router.upgrade);
    return { server: httpServer, tls: false };
  };

  const startListener = (
    listener: PathRouterListener,
    shouldBind: boolean,
    port: number,
    bind_address: string,
    build: () => { server: HttpServer | HttpsServer; tls: boolean },
  ): Promise<PathListenerStatus> => {
    if (!shouldBind) {
      // Listener elected off — no path enabled for this listener's
      // bit. Status row carries listening=false with no failure (off
      // is not a failure mode, just an explicit non-bind decision).
      return Promise.resolve({
        listener,
        port,
        listening: false,
        bind_address: null,
        tls: false,
      });
    }
    let built: { server: HttpServer | HttpsServer; tls: boolean };
    try {
      built = build();
    } catch (err) {
      failures.set(listener, 'tls_load_failed');
      log?.('error', 'path listener build failed', {
        listener,
        error: err instanceof Error ? err.message : String(err),
      });
      return Promise.resolve({
        listener,
        port,
        listening: false,
        bind_address,
        tls: false,
        failure: 'tls_load_failed',
      });
    }
    const { server, tls } = built;
    // Track every socket so an elective (forced) unbind can drop live
    // connections — `server.close()` blocks on them and Node's
    // `closeAllConnections()` misses upgraded WS sockets. The `connection`
    // event fires for ALL inbound sockets (before any HTTP upgrade), so
    // this set captures WS sockets too.
    const sockets = new Set<Socket>();
    server.on('connection', (s: Socket) => {
      sockets.add(s);
      s.once('close', () => sockets.delete(s));
    });
    return new Promise<PathListenerStatus>((resolve) => {
      const onError = (err: unknown): void => {
        const failure = classifyListenError(err);
        failures.set(listener, failure);
        log?.('error', 'path listener bind failed', {
          listener,
          port,
          bind: bind_address,
          code: (err as { code?: string } | null)?.code,
        });
        try { server.close(); } catch { /* swallow — listener never bound */ }
        resolve({
          listener,
          port,
          listening: false,
          bind_address,
          tls,
          failure,
        });
      };
      server.once('error', onError);
      server.listen(port, bind_address, () => {
        server.removeListener('error', onError);
        const addr = server.address();
        const resolvedPort = typeof addr === 'object' && addr ? addr.port : port;
        active.set(listener, {
          listener,
          server,
          bind_address,
          port: resolvedPort,
          tls,
          sockets,
        });
        failures.delete(listener);
        log?.('info', 'path listener bound', {
          listener,
          port: resolvedPort,
          bind: bind_address,
          tls,
        });
        resolve({
          listener,
          port: resolvedPort,
          listening: true,
          bind_address,
          tls,
        });
      });
    });
  };

  const stopListener = (listener: PathRouterListener, force = false): Promise<void> => {
    const entry = active.get(listener);
    if (!entry) return Promise.resolve();
    return new Promise<void>((resolve) => {
      entry.server.close(() => {
        active.delete(listener);
        log?.('info', 'path listener unbound', { listener });
        resolve();
      });
      if (force) {
        // The listener is being electively retired (its resolution bit
        // flipped off) — drop live connections so `close()` completes
        // instead of blocking forever on a long-lived WS that never
        // drains on its own. Destroy the tracked sockets directly:
        // Node's `closeAllConnections()` does NOT drop an upgraded
        // (WebSocket) socket, so tracking + destroy is the only reliable
        // release path.
        for (const s of entry.sockets) {
          try { s.destroy(); } catch { /* already destroyed */ }
        }
      }
    });
  };

  const buildStatus = (listener: PathRouterListener): PathListenerStatus => {
    const entry = active.get(listener);
    if (entry) {
      return {
        listener,
        port: entry.port,
        listening: true,
        bind_address: entry.bind_address,
        tls: entry.tls,
      };
    }
    const failure = failures.get(listener);
    // Off-by-resolution → no failure recorded; render listening=false
    // with the configured port + null bind_address.
    const shouldBind = listener === LAN_LISTENER ? anyPathLan(resolution) : anyPathPublic(resolution);
    const status: PathListenerStatus = {
      listener,
      port: listener === LAN_LISTENER ? lan_port : public_port,
      listening: false,
      bind_address: shouldBind ? (listener === LAN_LISTENER ? lan_bind_address : public_bind_address) : null,
      tls: false,
    };
    if (failure) status.failure = failure;
    return status;
  };

  return {
    start: async () => {
      const out: PathListenerStatus[] = [];
      // Sequential to mirror the legacy listener-set ordering — TLS
      // load happens once on the public listener; LAN is plaintext
      // and never contends for the cert.
      out.push(
        await startListener(
          LAN_LISTENER,
          anyPathLan(resolution),
          lan_port,
          lan_bind_address,
          () => ({ server: buildLanServer(), tls: false }),
        ),
      );
      out.push(
        await startListener(
          PUBLIC_LISTENER,
          anyPathPublic(resolution),
          public_port,
          public_bind_address,
          () => buildPublicServer(),
        ),
      );
      return out;
    },
    applyResolution: async (next: Record<PathRole, PathResolution>) => {
      // (1) Update the shared resolution IN PLACE. Both dispatchers
      // (LAN + public) read `resolution[role][listener]` live on every
      // request/upgrade through this same object reference, so the new
      // path set is served the instant the assignment lands — no router
      // rebuild, no socket teardown. Shallow-copy each entry so a later
      // caller mutation of `next` can't reach into the live router.
      for (const role of PATH_ROLES) {
        resolution[role] = { lan: next[role].lan, public: next[role].public };
      }
      // (2) Reconcile only the listeners whose bind decision flipped.
      // A listener that stays up is never touched — that's what keeps a
      // live control WS from wedging the rebind. A listener going off→on
      // binds fresh; on→off force-closes (its connections are leaving).
      const reconcile = async (
        listener: PathRouterListener,
        shouldBind: boolean,
        port: number,
        bind_address: string,
        build: () => { server: HttpServer | HttpsServer; tls: boolean },
        wantsTls: boolean,
      ): Promise<PathListenerStatus> => {
        const isUp = active.has(listener);
        // off→on (incl. retry after a prior bind failure): bind fresh.
        if (shouldBind && !isUp) {
          return startListener(listener, true, port, bind_address, build);
        }
        // Intentionally off: drop the listener if it's up, and clear any
        // stale failure (the old full-rebuild path got a fresh failures
        // map each transition; the in-place path must clear it itself).
        if (!shouldBind) {
          if (isUp) await stopListener(listener, true);
          failures.delete(listener);
          return buildStatus(listener);
        }
        // up→up: the live router already reflects the new resolution from
        // step (1), so a CONTENT flip touches no socket. The one case that
        // still needs a rebuild is a TLS-mode flip (plaintext↔https): the
        // server type is baked at `build()` time and can't be swapped on a
        // live socket. The old full-rebuild path re-read the cert holder
        // every apply, so preserve that — rebuild only this listener when
        // its bound mode no longer matches the cert holder.
        const entry = active.get(listener)!;
        if (entry.tls !== wantsTls) {
          await stopListener(listener, true);
          return startListener(listener, true, port, bind_address, build);
        }
        return buildStatus(listener);
      };
      // The public listener binds https iff the cert holder currently has
      // a usable chain — the same predicate `buildPublicServer` applies.
      // LAN is always plaintext.
      const pubChain = cert_chain.current();
      const publicWantsTls = !!(pubChain && pubChain.cert_pem && pubChain.private_key_pem);
      const out: PathListenerStatus[] = [];
      out.push(
        await reconcile(
          LAN_LISTENER,
          anyPathLan(resolution),
          lan_port,
          lan_bind_address,
          () => ({ server: buildLanServer(), tls: false }),
          false,
        ),
      );
      out.push(
        await reconcile(
          PUBLIC_LISTENER,
          anyPathPublic(resolution),
          public_port,
          public_bind_address,
          () => buildPublicServer(),
          publicWantsTls,
        ),
      );
      return out;
    },
    stop: async () => {
      const listeners = Array.from(active.keys());
      await Promise.all(listeners.map((l) => stopListener(l)));
    },
    status: () => [LAN_LISTENER, PUBLIC_LISTENER].map(buildStatus),
  };
};
