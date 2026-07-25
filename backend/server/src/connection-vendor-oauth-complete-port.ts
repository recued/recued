/** D-148 §A.12 / D-165 enroll-host #1 — `/oauth/complete` PortRequestHandler
 *  adapter (slice 2b).
 *
 *  Bridges the framework-neutral `handleVendorOAuthComplete` core to the
 *  user-server's Node http path-router: parses the GET query / POST JSON
 *  body into a `VendorOAuthCompleteRequest`, calls the core, and writes the
 *  response with hardened headers — `Cache-Control: no-store`, a
 *  hash-pinned CSP for the HTML pages, `nosniff`, `no-referrer`,
 *  frame-deny. On a successful completion it fires `onCompleted(flow_id)`;
 *  the slice-2b mount wires that to the `{flow_id}`-only completion bus
 *  event (the refresh_token is NEVER passed through here — it lives only in
 *  the result store, claimed point-to-point by the dialog).
 *
 *  Slice 3 activates the surface end-to-end: the `public` preset serves the
 *  `oauth` path role, this adapter answers the cloud page's cross-origin
 *  POST with CORS (OPTIONS preflight + ACAO for the `app.recued.com` cloud
 *  origin — the direct-GET path is same-window navigation and needs none),
 *  and the owner-bound `takeVendorOAuthResult` rpc hands the dialog the
 *  credential the `onCompleted` broadcast told it is ready. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { PortRequestHandler } from '@recued/server-tls';
import { OAUTH_CLOUD_CALLBACK_URL } from '@recued/contracts';
import {
  handleVendorOAuthComplete,
  GET_SCRUB_SCRIPT,
  type VendorOAuthCompleteDeps,
  type VendorOAuthCompleteRequest,
} from './connection-vendor-oauth-complete.js';

export interface VendorOAuthCompletePortHandlerDeps extends VendorOAuthCompleteDeps {
  /** Fired with the flow_id AFTER a successful completion response is
   *  written. Slice 2b wires this to the `{flow_id}` completion bus event.
   *  The refresh_token is never passed here. */
  onCompleted?: (flow_id: string) => void;
  /** POST body cap in bytes. OAuth callback bodies are tiny; default 64 KiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** sha256 of the inline scrub script's text, for the HTML CSP
 *  `script-src 'sha256-...'`. Computed once at module load. */
const SCRUB_SCRIPT_SHA256 = createHash('sha256')
  .update(GET_SCRUB_SCRIPT, 'utf8')
  .digest('base64');

/** CSP for the direct-GET HTML pages: deny everything, admit ONLY the one
 *  hash-pinned inline scrub script + cosmetic inline styles. The page's
 *  one attacker-influenced field (the error message) is HTML-escaped by
 *  the core, so this is defense-in-depth over the escaping. */
const HTML_CSP =
  `default-src 'none'; script-src 'sha256-${SCRUB_SCRIPT_SHA256}'; ` +
  "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The single cross-origin caller allowed to POST a code to this endpoint:
 *  the D-148 § A.12 cloud callback page at `app.recued.com`, which after
 *  verifying the signed state client-side `fetch`es
 *  `<server_url>/oauth/complete` with `mode: 'cors'` + JSON. Derived from
 *  the canonical callback-URL constant so the allowed origin can never drift
 *  from the page that actually posts. The DIRECT-GET path is same-window
 *  browser navigation (no Origin / no preflight), so it needs no CORS. */
const CLOUD_ORIGIN = new URL(OAUTH_CLOUD_CALLBACK_URL).origin;

/** Apply the CORS allowance for the cloud callback POST. A single fixed
 *  origin (not `*`, not request-echoed) — the browser blocks the response
 *  for any other origin. `Vary: Origin` keeps a shared cache from serving
 *  this ACAO to a different origin. No `Allow-Credentials`: the cloud page
 *  posts a plain JSON body with no cookies. */
const setCorsHeaders = (res: ServerResponse): void => {
  res.setHeader('Access-Control-Allow-Origin', CLOUD_ORIGIN);
  res.setHeader('Vary', 'Origin');
};

/** Read the request body with a hard byte cap (event-based, mirrors the
 *  connection webhook listener). Over-cap or any stream fault → not-ok. */
const readBodyCapped = (
  req: IncomingMessage,
  cap: number,
): Promise<{ ok: true; body: string } | { ok: false }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (r: { ok: true; body: string } | { ok: false }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) {
        // Settle IMMEDIATELY on cap breach — do NOT wait for 'end', or a
        // client that sends cap+1 bytes then stalls would park the handler
        // until the listener's socket timeout. Drop buffered bytes; the
        // settled-guard makes the trailing 'end'/'close'/'error' no-ops.
        chunks.length = 0;
        done({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done({ ok: true, body: Buffer.concat(chunks).toString('utf-8') }));
    req.on('error', () => done({ ok: false }));
    req.on('close', () => done({ ok: false }));
  });

const parseGetRequest = (rawUrl: string | undefined): VendorOAuthCompleteRequest => {
  let params: URLSearchParams;
  try {
    // Path-router only routes /oauth/complete here; a relative-URL base is
    // fine since we read only the query.
    params = new URL(rawUrl ?? '', 'http://localhost').searchParams;
  } catch {
    return { method: 'GET' };
  }
  const out: VendorOAuthCompleteRequest = { method: 'GET' };
  const code = params.get('code');
  const state = params.get('state');
  const err = params.get('error');
  const realmId = params.get('realmId');
  if (code) out.code = code;
  if (state) out.state = state;
  if (err) out.provider_error = err;
  if (realmId) out.realm_id = realmId;
  return out;
};

const parsePostBody = (body: string): VendorOAuthCompleteRequest => {
  const out: VendorOAuthCompleteRequest = { method: 'POST' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return out; // → core returns bad_request (missing state)
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (typeof o.code === 'string') out.code = o.code;
    if (typeof o.state === 'string') out.state = o.state;
    if (typeof o.flow_id === 'string') out.flow_id = o.flow_id;
    if (typeof o.error === 'string') out.provider_error = o.error;
    if (typeof o.realmId === 'string') out.realm_id = o.realmId;
  }
  return out;
};

/** Build the `/oauth/complete` PortRequestHandler. Slice 2b mounts this on
 *  BOTH the LAN and public listeners — the provider redirect (direct GET)
 *  and the cloud-page POST both arrive over the public internet. */
export const createVendorOAuthCompletePortHandler = (
  deps: VendorOAuthCompletePortHandlerDeps,
): PortRequestHandler => {
  const cap = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // CORS preflight — the cloud callback page POSTs cross-origin with a
    // JSON content-type, which is not a "simple" request, so the browser
    // sends an OPTIONS preflight first. Answer it BEFORE the method gate
    // (OPTIONS is neither GET nor POST and would otherwise 405).
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      setCorsHeaders(res);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }

    const method = req.method === 'POST' ? 'POST' : req.method === 'GET' ? 'GET' : null;
    if (method === null) {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      res.setHeader('Cache-Control', 'no-store');
      res.end('method_not_allowed');
      return;
    }

    let request: VendorOAuthCompleteRequest;
    if (method === 'POST') {
      const read = await readBodyCapped(req, cap);
      if (!read.ok) {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        // CORS so the cross-origin cloud page can actually read this rejection.
        setCorsHeaders(res);
        // The client may still be uploading an oversize body we've stopped
        // reading — signal close rather than hold the socket.
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
        return;
      }
      request = parsePostBody(read.body);
    } else {
      request = parseGetRequest(req.url);
    }

    const result = await handleVendorOAuthComplete(deps, request);

    res.statusCode = result.status;
    res.setHeader('Content-Type', result.content_type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (result.content_type.startsWith('text/html')) {
      res.setHeader('Content-Security-Policy', HTML_CSP);
    }
    // The POST path is the cross-origin cloud-callback fetch — it must carry
    // the ACAO so the browser surfaces the JSON outcome to the page. The GET
    // path is same-window navigation (no Origin), so it needs no CORS header.
    if (method === 'POST') setCorsHeaders(res);
    res.end(result.body);

    if (result.outcome === 'completed' && result.flow_id) {
      // Fire-and-forget completion signal AFTER the response is written. A
      // broken listener must never break the OAuth response.
      try {
        deps.onCompleted?.(result.flow_id);
      } catch {
        /* swallow */
      }
    }
  };
};
