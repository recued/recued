/** D-148 P6 § A.6 — webhook port handler.
 *
 *  Single port that hosts every inbound vendor webhook. Per-vendor
 *  HMAC verification + 24h replay-window dedup + the spec-mandated
 *  "no vendor fingerprint on 404" rule (§ P6 acceptance line 2155):
 *  any path that doesn't match a configured vendor returns a
 *  generic 404 with NO body fingerprint of which vendors are
 *  configured.
 *
 *  Vendor matching is via a closed-list registry the substrate
 *  caller wires at boot. Each entry exposes:
 *    - the canonical path prefix (e.g. `/v1/connection/webhook/<vendor>/`)
 *    - the per-vendor message canonicalizer + signature header
 *    - the per-vendor event-id extractor (for replay dedup)
 *    - the dispatch sink (forwards to the existing funnel —
 *      `connection-webhook-listener.ts` keeps the durable path)
 *
 *  The port handler does NOT replicate the funnel's internals —
 *  this is the *front-line* gate. The funnel still runs HMAC verify
 *  + persistent dedup + dispatch on the dispatch sink. The double-
 *  check is intentional defense-in-depth. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { WEBHOOK_BODY_MAX_BYTES } from '@recued/contracts';
import { writeJson } from '../common/respond.js';
import {
  type IdempotencyLedger,
} from './idempotency-ledger.js';

// Codex P2 #6 fold — align default with spec § A.6 line 812 +
// `WEBHOOK_BODY_MAX_BYTES` (10 MB). The legacy
// `connection-webhook-listener.ts` carries its own 1 MB cap; that
// shim stays untouched so existing wiring keeps its surface, but
// the new D-148 webhook port adopts the documented contract.
const DEFAULT_MAX_BODY_BYTES = WEBHOOK_BODY_MAX_BYTES;

/** Per-vendor webhook descriptor. The substrate registry holds one
 *  entry per (vendor, connection_name) tuple — the same shape the
 *  existing connection-webhook-listener already exposes. */
export interface WebhookVendorDescriptor {
  /** Canonical path prefix the vendor's deliveries land at. The
   *  matcher requires the request path to *start with* the prefix
   *  AND consume one additional path segment as the connection
   *  name. */
  path_prefix: string;
  /** Per-vendor event id extractor. Reads the inbound headers + body
   *  and returns the dedup key. Must be a stable per-event id
   *  emitted by the vendor (HubSpot `eventId`, Salesforce CometD
   *  `replayId`, Slack `event_id`). Returns null when the vendor
   *  doesn't emit an id (the caller falls back to body hash). */
  extractEventId: (req: IncomingMessage, body: Buffer) => string | null;
  /** D-148 P9 Codex P9 #4 fold — opt-out predicate for dedup.
   *  Vendors with control-plane requests that must not enter the
   *  replay-window ledger (Slack URL verification — Slack may
   *  reissue the same challenge during workspace re-connect, and
   *  blocking the second emit would leave the URL stuck) return true
   *  here so the handler short-circuits to dispatch without
   *  recording. Optional + defaults to false; existing vendors
   *  (HubSpot, Salesforce) leave it unset and keep current dedup
   *  semantics. */
  shouldSkipDedup?: (req: IncomingMessage, body: Buffer) => boolean;
  /** Per-vendor signature verifier. Returns true iff the inbound
   *  request matches the vendor's signing scheme (HMAC, header-
   *  embedded secret, etc.). */
  verifySignature: (req: IncomingMessage, body: Buffer, secret: string) => boolean;
  /** Vendor signing-secret resolver, keyed on the connection name.
   *  Returns null when no connection by that name is configured.
   *  Caller injects this so the substrate stays decoupled from the
   *  vault. */
  resolveSecret: (connection_name: string) => string | null;
  /** D-192 WhatsApp make-live — the OWNERSHIP HANDSHAKE, on a GET.
   *
   *  Meta will not deliver a single POST to this endpoint until it answers a GET
   *  (`?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`) by echoing the raw
   *  challenge. That is not a nicety — it is how the subscription gets created at
   *  all, so a POST-only port simply cannot host a WhatsApp connection.
   *
   *  Distinct from Slack's `url_verification`, which is a POST and rides
   *  `dispatch`'s `response_override`. This is a different HTTP METHOD, which is
   *  why it needs a hook of its own rather than another branch inside dispatch.
   *
   *  A vendor that declares none keeps the port's previous behavior EXACTLY: a
   *  GET to its path answers the same generic 404 as an unwired path.
   *
   *  ⚠ Return `null` for every failure — wrong mode, absent / mismatched token,
   *  missing challenge — and the handler renders that as the same generic 404.
   *  This is what stops the hook from widening the port's fingerprint: without the
   *  verify token, a GET cannot distinguish a live WhatsApp connection from a path
   *  that was never configured. The handshake runs BEFORE any body read, secret
   *  resolution, or dedup, because a GET carries no body and must never enter the
   *  replay ledger (a re-verify would otherwise echo `{deduped:true}` and leave
   *  the subscription stuck — the same trap Slack's `shouldSkipDedup` exists for). */
  verifyChallenge?: (
    req: IncomingMessage,
    connection_name: string,
  ) => { status: number; body: string; content_type: string } | null;
  /** Final dispatch — typically forwards to the existing webhook
   *  funnel. Receives the parsed payload + headers.
   *
   *  D-148 P9 — `response_override` lets vendors (Slack URL
   *  verification) substitute the default `{ ok: true }` envelope with
   *  a custom body / content-type. Slack expects the verifier to echo
   *  the `challenge` field as `text/plain` (or as JSON inside `{
   *  "challenge": "…" }`). Existing dispatchers (HubSpot, Salesforce)
   *  ignore this slot — backward-compatible. */
  dispatch: (params: {
    connection_name: string;
    body: Buffer;
    headers: Record<string, string>;
  }) => Promise<{
    ok: boolean;
    response_override?: {
      status: number;
      body: string;
      content_type: string;
    };
  }>;
}

export interface WebhookPortHandlerOptions {
  /** Closed-list vendor registry. Keys are the vendor slug. */
  vendors: Record<string, WebhookVendorDescriptor>;
  /** 24h dedup ledger. Front-line filter; the durable per-vendor
   *  ledger lives on the funnel side. */
  ledger: IdempotencyLedger;
  /** Max inbound body bytes. Defaults to 1 MB. */
  max_body_bytes?: number;
  /** Optional logger. */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

const readBodyWithCap = async (
  req: IncomingMessage,
  cap: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' }> => {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    let settled = false;
    const done = (
      r: { ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' },
    ): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) done({ ok: false, reason: 'too_large' });
      else done({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on('error', () => done({ ok: false, reason: 'stream_error' }));
    req.on('close', () => done({ ok: false, reason: 'stream_error' }));
  });
};

const normaliseHeaders = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v.length > 0) out[k.toLowerCase()] = v[0]!;
  }
  return out;
};

/** Build the webhook port handler. Returns an HTTP-shaped function
 *  the listener-set dispatches request to. */
export const createWebhookPortHandler = (
  options: WebhookPortHandlerOptions,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  const cap = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const { vendors, ledger, log } = options;
  return async (req, res) => {
    const url = req.url ?? '/';
    const [pathname] = url.split('?');

    // POST is a delivery. GET is only ever an ownership HANDSHAKE, and only for a
    // vendor that declares `verifyChallenge` (D-192 WhatsApp: Meta refuses to
    // deliver anything until the endpoint echoes `hub.challenge` on a GET). Every
    // other method keeps the generic 404 so the port never leaks which
    // path-prefixes are wired — spec § P6 acceptance line 2155: no fingerprint.
    // A GET that fails the handshake gets that SAME 404 below, so admitting the
    // method widens nothing: without the verify token, a GET still cannot tell a
    // live connection from a path that was never configured.
    if (req.method !== 'POST' && req.method !== 'GET') {
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }

    // Match the prefix against the configured vendor registry.
    let matchedVendor: { slug: string; descriptor: WebhookVendorDescriptor; connection_name: string } | null = null;
    for (const [slug, descriptor] of Object.entries(vendors)) {
      if (!pathname.startsWith(descriptor.path_prefix)) continue;
      // Require exactly one more path segment after the prefix.
      const remainder = pathname.slice(descriptor.path_prefix.length);
      if (remainder.length === 0) continue;
      // Reject deeper nesting (`/v1/connection/webhook/hubspot/conn/extra`)
      // — the connection name is a single segment.
      if (remainder.includes('/')) continue;
      // Codex P2 #4 fold — wrap decodeURIComponent in try/catch.
      // Malformed percent-encoding (e.g. trailing `%` with no hex
      // pair) throws synchronously and would otherwise punch through
      // the vendor-agnostic 404 path with a 500 / unhandled rejection.
      let connection_name: string;
      try {
        connection_name = decodeURIComponent(remainder);
      } catch {
        // Treat malformed encoding as a non-match — generic 404 like
        // any other unconfigured path. Keeps the vendor-agnostic
        // promise intact (no leak, no 500).
        continue;
      }
      // Percent-decoding can introduce a path separator (`%2F`) after the raw
      // remainder passed the nesting check above. Recheck the decoded value so
      // the connection name remains exactly one URL segment.
      if (connection_name.length === 0 || connection_name.includes('/')) continue;
      matchedVendor = { slug, descriptor, connection_name };
      break;
    }

    if (!matchedVendor) {
      // Vendor-agnostic 404. No mention of any configured vendor in
      // the body — same response shape regardless of which path the
      // caller probed.
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }

    if (req.method === 'GET') {
      // The ownership handshake, BEFORE any body read, secret resolution, or
      // dedup: a GET carries no body, and it must never enter the replay ledger —
      // a legitimate re-verify would otherwise be answered `{deduped:true}` and
      // leave the subscription stuck (the same trap Slack's `shouldSkipDedup`
      // exists for on its POST-shaped challenge).
      const challenge = matchedVendor.descriptor.verifyChallenge?.(
        req,
        matchedVendor.connection_name,
      );
      if (challenge === undefined || challenge === null) {
        // No hook, or a failed handshake — indistinguishable, on purpose.
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      // Echoed VERBATIM. Meta compares the challenge body byte for byte, so a
      // JSON-wrapped echo silently fails the subscription while every other part
      // of the endpoint looks healthy.
      res.statusCode = challenge.status;
      res.setHeader('Content-Type', challenge.content_type);
      res.end(challenge.body);
      return;
    }

    const bodyResult = await readBodyWithCap(req, cap);
    if (!bodyResult.ok) {
      if (bodyResult.reason === 'too_large') {
        writeJson(res, 413, { error: { code: 'payload_too_large' } });
        return;
      }
      writeJson(res, 400, { error: { code: 'stream_error' } });
      return;
    }

    const secret = matchedVendor.descriptor.resolveSecret(matchedVendor.connection_name);
    if (secret === null) {
      // Connection not configured; same generic 404 shape so the port
      // doesn't disclose which (vendor, connection) tuples are wired.
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }

    const sigOk = matchedVendor.descriptor.verifySignature(req, bodyResult.body, secret);
    if (!sigOk) {
      writeJson(res, 401, { error: { code: 'signature_invalid' } });
      log?.('warn', 'webhook signature rejected', {
        vendor: matchedVendor.slug,
        connection_name: matchedVendor.connection_name,
      });
      return;
    }

    // Codex P2 #3 fold — when the vendor doesn't surface an event_id
    // we MUST still dedup; otherwise an attacker who captures a
    // signed delivery can replay it inside the 24h window and the
    // ledger never sees the duplicate. Body-hash fallback is the
    // closest approximation: the signed payload includes a vendor
    // timestamp, so two genuinely-distinct events have distinct
    // canonical bytes.
    //
    // Codex P9 #4 fold — vendors may opt out of dedup for genuine
    // control-plane requests (Slack URL verification): we skip the
    // ledger record entirely and head straight to dispatch. Without
    // this opt-out, Slack reissuing the same challenge during a
    // workspace re-connect would land in the replay window and the
    // handler would echo `{deduped: true}` instead of the
    // challenge — breaking URL re-verification.
    const shouldSkipDedup = matchedVendor.descriptor.shouldSkipDedup?.(req, bodyResult.body) ?? false;
    if (!shouldSkipDedup) {
      const event_id = matchedVendor.descriptor.extractEventId(req, bodyResult.body);
      const dedup_key = event_id ?? `body:${createHash('sha256').update(bodyResult.body).digest('hex')}`;
      const dedup = ledger.record(matchedVendor.slug, dedup_key);
      if (!dedup.fresh) {
        writeJson(res, 200, { ok: true, deduped: true });
        return;
      }
    }

    const dispatchResult = await matchedVendor.descriptor.dispatch({
      connection_name: matchedVendor.connection_name,
      body: bodyResult.body,
      headers: normaliseHeaders(req),
    });
    if (!dispatchResult.ok) {
      writeJson(res, 502, { error: { code: 'dispatch_failed' } });
      return;
    }
    if (dispatchResult.response_override) {
      const { status, body, content_type } = dispatchResult.response_override;
      res.statusCode = status;
      res.setHeader('Content-Type', content_type);
      res.end(body);
      return;
    }
    writeJson(res, 200, { ok: true, deduped: false });
  };
};
