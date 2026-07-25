/** D-158 P2b-ii — `/ask/<ask_id>` notification ask-landing PortRequestHandler.
 *
 *  The server-wiring slice for the `channels/ask-landing.ts` leaf
 *  (`@recued/notification`). The leaf ships the pure render + decode
 *  functions (`renderAskLandingHtml` / `parseAskLandingSubmission`) + the
 *  security header set (`ASK_LANDING_RESPONSE_HEADERS`); this handler serves
 *  them over HTTP and supplies the routing knowledge the leaf cannot hold:
 *
 *    GET  → load the `PendingAsk` (`deps.getAsk`); an `open` ask renders the
 *           option form with a freshly-issued single-use form-nonce + the
 *           same-origin POST action; an answered / handled ask renders the
 *           honest "already answered" page; an unknown / pruned ask renders a
 *           generic "no longer available" page (404).
 *    POST → same-origin guard → read the capped body →
 *           `parseAskLandingSubmission` → cross-check the body `ask_id`
 *           against the path → consume the single-use form-nonce →
 *           `deps.submitAnswer` → re-render the resulting page.
 *
 *  Notification-native, NOT a D-149 reception endpoint (the leaf header is
 *  emphatic): the page is backed by the block's own `PendingAsk` store, the
 *  unguessable `ask_id` (a 122-bit UUID emailed only to the user) is the
 *  bearer capability, and the single-use form-nonce + same-origin check
 *  guard the POST. It REUSES the reception *substrate patterns* — the
 *  body-cap reader (modelled on the `/oauth/complete` port), the
 *  `verifyReceptionSameOrigin` guard (a generic same-origin check despite
 *  the name), and the per-process single-use nonce store — not the reception
 *  endpoint kind.
 *
 *  Mounted on the `ask` PathRole (`PATH_FOR_ROLE.ask` = `/ask`), an opt-in
 *  public surface served by the `public` exposure preset (like `reception` /
 *  `oauth`). The emailed one-click link is only built on a publicly-reachable
 *  server (`getShareBaseUrl` resolves), so a LAN-only deployment never links
 *  the route.
 *
 *  Spec: docs/d-158-spec.md § P2 / A.4 / A.6 / N.4 / I-9. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PortRequestHandler } from '@recued/server-tls';
import { PATH_FOR_ROLE } from '@recued/contracts';
import {
  ASK_LANDING_RESPONSE_HEADERS,
  parseAskLandingSubmission,
  renderAskLandingHtml,
  type AskLandingDetail,
  type InboundReply,
  type PendingAsk,
} from '@recued/notification';
import { verifyReceptionSameOrigin } from './ports/reception/handlers/same-origin.js';
import type { AskLandingNonceStore } from './ask-landing-nonce-store.js';

export interface AskLandingPortHandlerDeps {
  /** Read one ask by id — `block.getAsk`. Returns null for an unknown /
   *  pruned ask. */
  getAsk: (ask_id: string) => Promise<PendingAsk | null>;
  /** Record an answer — `block.submitAnswer`. No-throw + first-answer-wins:
   *  it re-validates the option against the persisted ask and dedups, so the
   *  route's job upstream is only authentication (capability + nonce +
   *  same-origin). */
  submitAnswer: (reply: InboundReply) => Promise<void>;
  /** Read the anti-phishing verification phrase — from
   *  `block.getNotificationSettings().verification_phrase`. Rendered on the
   *  page so a static phishing clone (which cannot know it) visibly fails the
   *  soft-trust check. Undefined → the user set no phrase. */
  getVerificationPhrase: () => Promise<string | undefined>;
  /** D-210 A.8 3d-2b — resolve the held operation's concrete details for an
   *  `open` ask (`createAskLandingDetailResolver`). Rendered above the
   *  options so the decision is made with the values in view: for a single
   *  hold the ask prose names the operation but enumerates nothing.
   *
   *  Optional + best-effort. Absent, resolving to null, or THROWING all
   *  yield the pre-3d-2b page — the details are an enrichment of a decision
   *  surface, never a precondition for it, so a failure costs the block and
   *  never the ask. */
  resolveDetails?: (
    ask: PendingAsk,
  ) => Promise<{ heading?: string; details: readonly AskLandingDetail[] } | null>;
  /** D-210 A.8 3d-2c — the submit-IS-the-approve leg
   *  (`createAskLandingEditApproval`). Called INSTEAD of `submitAnswer`
   *  when the body carried `edit.*` fields.
   *
   *  Composed together with `resolveDetails`' `editable` flag off the same
   *  bundle: a page that renders controls can always honour them, and a
   *  page that cannot renders none. Absent + edits present ⇒ an honest
   *  refusal (below), never a silent drop. */
  submitEditedApproval?: (input: {
    ask: PendingAsk;
    option: string;
    rawEdits: Record<string, string>;
  }) => Promise<{ ok: boolean; message?: string }>;
  /** Single-use form-nonce store (CSRF). Keyed on `ask_id`. */
  nonceStore: AskLandingNonceStore;
  /** Injected clock — tests pass a fixed value. Default `Date.now`. */
  now?: () => number;
  /** POST body cap in bytes. A landing submission is tiny (nonce + ask_id +
   *  option); default 16 KiB matches the reception form cap. */
  maxBodyBytes?: number;
  /** Trust `X-Forwarded-Proto` for the same-origin scheme check — set only
   *  when the listener sits behind a trusted TLS-terminating reverse proxy.
   *  A direct-internet listener must leave this false (the header is
   *  visitor-forgeable). Mirrors the reception handlers' posture. */
  trustForwardedProto?: boolean;
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/** Read the request body with a hard byte cap (event-based, mirrors the
 *  `/oauth/complete` port reader). Over-cap or any stream fault → not-ok. */
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

/** Pull the `ask_id` out of a `/ask/<ask_id>` request path (query stripped).
 *  Returns null for any shape that is not exactly one path segment under the
 *  role base — the handler then renders the generic unavailable page. */
const ASK_BASE = PATH_FOR_ROLE.ask;
const parseAskIdFromPath = (rawUrl: string | undefined): string | null => {
  const path = (rawUrl ?? '').split('?')[0]!.split('#')[0]!;
  if (!path.startsWith(`${ASK_BASE}/`)) return null;
  const rest = path.slice(ASK_BASE.length + 1).replace(/\/+$/, '');
  if (rest.length === 0 || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
};

/** Spread the leaf's mandated security headers + content-type onto the HTML
 *  response. The leaf renders HTML but cannot set headers (`x-frame-options`
 *  is header-only — silently ignored from a `<meta>` CSP), so the route
 *  spreads `ASK_LANDING_RESPONSE_HEADERS` here. */
const writeHtml = (res: ServerResponse, body: string, status: number): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  for (const [key, value] of Object.entries(ASK_LANDING_RESPONSE_HEADERS)) {
    res.setHeader(key, value);
  }
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

/** The generic "no longer available" page for an unknown / pruned `ask_id`.
 *  Static — no interpolation, no capability leak (the 122-bit id is
 *  unguessable, so this covers a genuinely expired / answered-then-pruned
 *  ask rather than enumeration). Self-contained; the leaf renders only the
 *  open + answered pages. */
const UNAVAILABLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'">
<meta name="robots" content="noindex,nofollow">
<title>No longer available</title>
<style>body{margin:0;background:#f4f4f5;color:#18181b;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.shell{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.1);max-width:480px;width:100%;padding:32px}.brand{margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#71717a}h1{margin:0 0 12px;font-size:21px;line-height:1.3}p{margin:0;color:#3f3f46}</style>
</head>
<body>
<div class="shell">
<div class="card">
<p class="brand">Recued</p>
<h1>No longer available</h1>
<p>This decision link has expired or has already been handled. There is nothing for you to do here.</p>
</div>
</div>
</body>
</html>
`;

/** D-210 A.8 3d-2b — the held op's details for an `open` ask, best-effort.
 *  A throwing / absent resolver yields no block: the ask still renders and
 *  is still answerable. (Same posture as 3d-2a's answer-link builder — an
 *  enrichment never costs the decision surface.) */
const resolveDetailsSafely = async (
  deps: AskLandingPortHandlerDeps,
  ask: PendingAsk,
): Promise<{ heading?: string; details: readonly AskLandingDetail[] } | null> => {
  if (deps.resolveDetails === undefined) return null;
  try {
    return await deps.resolveDetails(ask);
  } catch {
    return null;
  }
};

/** Render the page for an ask's current state. `open` issues a fresh
 *  single-use nonce + renders the option form; answered / handled renders
 *  the honest "already answered" page; null renders the unavailable page. */
const respondWithAskPage = async (
  deps: AskLandingPortHandlerDeps,
  res: ServerResponse,
  ask_id: string,
  ask: PendingAsk | null,
  verification_phrase: string | undefined,
  now: number,
  details_error?: string,
): Promise<void> => {
  if (ask === null) {
    writeHtml(res, UNAVAILABLE_HTML, 404);
    return;
  }
  if (ask.status === 'open') {
    const form_nonce = deps.nonceStore.issue(ask_id, now);
    // Only the `open` page carries details: once the ask is answered the
    // hold is consumed, so there is nothing left to resolve and nothing the
    // reader can still act on.
    const resolved = await resolveDetailsSafely(deps, ask);
    const html = renderAskLandingHtml({
      ask,
      ...(verification_phrase !== undefined ? { verification_phrase } : {}),
      ...(resolved !== null ? { details: resolved.details } : {}),
      ...(resolved?.heading !== undefined ? { details_heading: resolved.heading } : {}),
      ...(details_error !== undefined ? { details_error } : {}),
      form_nonce,
      action: `${ASK_BASE}/${encodeURIComponent(ask_id)}`,
    });
    writeHtml(res, html, 200);
    return;
  }
  // answered / handled — the leaf renders the honest cross-channel status;
  // form_nonce + action are ignored for a non-open ask.
  const html = renderAskLandingHtml({
    ask,
    ...(verification_phrase !== undefined ? { verification_phrase } : {}),
    form_nonce: '',
    action: '',
  });
  writeHtml(res, html, 200);
};

/** Build the `/ask/<ask_id>` PortRequestHandler. Mounted (slice) on the
 *  `ask` PathRole; served publicly only under the `public` exposure preset. */
export const createAskLandingPortHandler = (
  deps: AskLandingPortHandlerDeps,
): PortRequestHandler => {
  const now = deps.now ?? (() => Date.now());
  const cap = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method === 'POST' ? 'POST' : req.method === 'GET' ? 'GET' : null;
    if (method === null) {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, POST');
      res.setHeader('cache-control', 'no-store');
      res.end('method_not_allowed');
      return;
    }

    const ask_id = parseAskIdFromPath(req.url);
    if (ask_id === null) {
      writeHtml(res, UNAVAILABLE_HTML, 404);
      return;
    }

    if (method === 'GET') {
      const [ask, verification_phrase] = await Promise.all([
        deps.getAsk(ask_id),
        deps.getVerificationPhrase(),
      ]);
      await respondWithAskPage(deps, res, ask_id, ask, verification_phrase, now());
      return;
    }

    // POST — same-origin guard FIRST (cheap reject before reading the body).
    if (!verifyReceptionSameOrigin(req, deps.trustForwardedProto)) {
      res.statusCode = 403;
      res.setHeader('cache-control', 'no-store');
      res.end('forbidden');
      return;
    }

    const read = await readBodyCapped(req, cap);
    if (!read.ok) {
      res.statusCode = 413;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('connection', 'close');
      res.end('payload_too_large');
      return;
    }

    const submission = parseAskLandingSubmission(read.body);
    if ('error' in submission) {
      res.statusCode = 400;
      res.setHeader('cache-control', 'no-store');
      res.end('bad_request');
      return;
    }

    // The body `ask_id` (a hidden field) must agree with the path. A
    // mismatch is a tampered form — reject before touching the nonce store.
    if (submission.reply.ask_id !== ask_id) {
      res.statusCode = 400;
      res.setHeader('cache-control', 'no-store');
      res.end('bad_request');
      return;
    }

    // Consume the single-use form-nonce (CSRF). A replay, a cross-origin
    // POST, or a nonce never issued for this ask all fail here.
    if (!deps.nonceStore.consume(ask_id, submission.form_nonce, now())) {
      res.statusCode = 403;
      res.setHeader('cache-control', 'no-store');
      res.end('forbidden');
      return;
    }

    // D-210 A.8 3d-2c — a body carrying `edit.*` fields is an EDIT-then-
    // APPROVE, not a plain answer: it must reach the approve funnel (which
    // validates against the allowlist, writes through the narrow
    // `setArgOverrides`, audits old→new, and only then releases).
    //
    // ⛔ Never fall through to `submitAnswer` with edits in hand. That path
    // takes an option and nothing else, so it would release the hold with
    // the ORIGINAL args while the page reported success — the owner retimes
    // a booking, reads "Response recorded: Approve", and 3d-1 mails the
    // visitor the time they did not choose.
    let details_error: string | undefined;
    if (submission.edits !== undefined) {
      if (deps.submitEditedApproval === undefined) {
        // A page that rendered controls always has this bound (they are
        // composed together). Reaching here means edits arrived for a page
        // that never offered them — refuse rather than discard them.
        details_error = 'This server cannot accept changes to this request.';
      } else {
        const current = await deps.getAsk(ask_id);
        if (current === null || current.status !== 'open') {
          details_error = 'This request is no longer waiting for a decision.';
        } else {
          let outcome: { ok: boolean; message?: string };
          try {
            outcome = await deps.submitEditedApproval({
              ask: current,
              option: submission.reply.option,
              rawEdits: submission.edits,
            });
          } catch {
            // A thrown approve is NOT a silent success. The nonce is already
            // spent, so the re-render below issues a fresh one and the owner
            // can retry — nothing was released.
            outcome = { ok: false, message: 'The request could not be approved.' };
          }
          if (!outcome.ok) {
            details_error = outcome.message ?? 'The request could not be approved.';
          }
        }
      }
    } else {
      // The block re-validates the option against the persisted ask + dedups
      // (first-answer-wins); a no-op leaves the ask open and the re-render
      // below shows the form again with a fresh nonce.
      await deps.submitAnswer(submission.reply);
    }

    const [ask, verification_phrase] = await Promise.all([
      deps.getAsk(ask_id),
      deps.getVerificationPhrase(),
    ]);
    await respondWithAskPage(
      deps,
      res,
      ask_id,
      ask,
      verification_phrase,
      now(),
      details_error,
    );
  };
};
