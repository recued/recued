/** D-148 § A.6 — path-handler abstraction (Amendment 2026-05-11; W3.5).
 *
 *  The user's server runs two listeners (LAN port 80 plain HTTP +
 *  public port 443 TLS), both fronted by a single path-routing
 *  dispatcher serving `/health`, `/ws`, `/mcp`, `/webhooks/*`,
 *  `/reception/*`. The per-path handler abstraction below is what each
 *  role implements; the listener layer dispatches by URL path inside
 *  each listener.
 *
 *  This module ships the substrate primitives — the `PortRequestHandler`
 *  / `PortUpgradeHandler` contracts every role implements + the
 *  `CertChain` slot the listener set re-binds at rotation time. The
 *  actual per-role handlers live under `backend/server/src/ports/`. */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Per-role HTTP-shaped handler. The path-router dispatches to the
 *  handler matching the URL path (per `matchesPathRole` from contracts);
 *  cross-role routing is forbidden by construction (each role has
 *  exactly one handler). The handler is responsible for emitting its
 *  own response + closing the stream. */
export type PortRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/** WebSocket-upgrade handler. Real WS upgrades arrive on the
 *  underlying http server's `'upgrade'` event with a raw socket +
 *  head buffer — they never enter the request/response pipeline.
 *  Roles that need WS upgrade routing (the `ws` role at v1; future
 *  Reception upgrade flows) wire this handler into the path-listener
 *  set's `upgradeHandlers` map. */
export type PortUpgradeHandler = (
  req: IncomingMessage,
  socket: import('node:net').Socket,
  head: Buffer,
) => void;

/** Shared TLS material. The listener set treats this as opaque
 *  bytes; the substrate doesn't parse the cert here. The actual
 *  parsing + validation lives in the `cert-chain.ts` helpers and the
 *  Reachability Doctor's TLS block.
 *
 *  Three TLS modes per `resolveTlsIntegration` from
 *  `@recued/server-network`:
 *    - `recued-acme`: the server holds the keypair locally; this
 *      shape is what the listener wraps in https.createServer.
 *    - `certbot` / `caddy`: TLS terminated upstream — `private_key`
 *      is empty + the listener binds plaintext. The `cert_pem` slot
 *      may still be populated for diagnostics. */
export interface CertChain {
  cert_pem: string;
  private_key_pem: string;
  /** SHA-256 fingerprint of the leaf cert (lowercase hex, no
   *  separators). Used by the Reachability Doctor's TLS block + the
   *  `cert_fingerprint_mismatch` recommendation. Empty when no cert
   *  is loaded (LAN-only / certbot / caddy modes). */
  fingerprint?: string;
  /** Unix-ms; 0 when unknown. */
  expires_at?: number;
}

/** Closed-list failure reason. Same taxonomy across LAN + public
 *  listeners; the Reachability Doctor maps each reason to a
 *  remediation hint. */
export type ListenerFailureReason =
  | 'port_in_use'
  | 'permission_denied'
  | 'address_unreachable'
  | 'tls_load_failed'
  | 'unknown';
