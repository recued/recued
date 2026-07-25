/** D-149 § Must Hold I-12b — the same-origin POST guard shared by every
 *  reception write handler (intake / scheduling-book / approval / drop).
 *
 *  Previously each handler carried its own copy of this check (they had
 *  drifted in comments); this is the single source of truth.
 *
 *  The visitor's `Origin` (or the `Referer` fallback for browsers that
 *  historically omit `Origin` on same-origin POSTs) must match the
 *  server's own `Host`. Scheme is ALSO required to match — but ONLY when
 *  the caller passes `trustForwardedProto: true`, i.e. the listener sits
 *  behind a trusted reverse proxy that sets `X-Forwarded-Proto`. A
 *  direct-internet-facing listener must NOT trust that header (a visitor
 *  could forge it), so the default is host-only — exactly the prior
 *  behavior, with no risk of rejecting a legitimate same-origin POST and
 *  no forgeable input. The scheme tightening is thus a sound opt-in.
 *
 *  This is DEFENSE IN DEPTH: the single-use, per-render form nonce
 *  (unreadable cross-origin) is the primary CSRF defense. So an OPAQUE
 *  `Origin: null` — what a same-origin no-JS `<form>` POST sends from an
 *  I-12b `no-referrer` page — is PERMITTED (deferring to that nonce) rather
 *  than 403'd; see the inline note. A concrete cross-origin Origin is still
 *  rejected. */

import type { IncomingMessage } from 'node:http';

export const verifyReceptionSameOrigin = (
  req: IncomingMessage,
  trustForwardedProto = false,
): boolean => {
  const host = req.headers['host'];
  if (typeof host !== 'string' || host.length === 0) return false;

  // The public scheme iff a TRUSTED proxy declared it (first hop wins).
  // Never read the header on a direct listener — it'd be visitor-forgeable.
  const xfp = trustForwardedProto ? req.headers['x-forwarded-proto'] : undefined;
  const fwdProto =
    typeof xfp === 'string' && xfp.length > 0 ? xfp.split(',')[0]!.trim().toLowerCase() : null;

  const matches = (raw: string): boolean => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.host !== host) return false;
    // Tighten on scheme only when the public one is actually known.
    if (fwdProto !== null && u.protocol !== `${fwdProto}:`) return false;
    return true;
  };

  const origin = req.headers['origin'];
  if (typeof origin === 'string' && origin.length > 0) {
    // `null` is an OPAQUE origin — exactly what a SAME-ORIGIN navigation POST
    // (the JS-free upload / submit `<form>`) sends from a `Referrer-Policy:
    // no-referrer` page (Must Hold I-12b, kept so the `?t=` bearer never leaks
    // via Referer — incl. to same-origin asset fetches). Per the Fetch spec the
    // Origin is nulled on a non-CORS, non-GET request under `no-referrer`, so a
    // legitimate no-JS visitor submit arrives with `Origin: null` + no Referer.
    // That is NOT cross-origin-attributable, so the same-origin check cannot
    // adjudicate it; permit it and defer to the PRIMARY CSRF defense — the
    // single-use, per-render form nonce (unreadable cross-origin, so a real
    // CSRF attacker — even one posting `Origin: null` from a sandboxed iframe —
    // still cannot forge a valid POST). A CONCRETE cross-origin Origin is still
    // rejected by `matches` below. Without this, the strict I-12b posture 403s
    // every no-JS reception form submit (the JS path is unaffected: `fetch()` is
    // CORS-mode, so it always sends the real Origin).
    if (origin === 'null') return true;
    // A present, concrete Origin is authoritative — no Referer fallback
    // (mirrors the prior per-handler behavior).
    return matches(origin);
  }

  const referer = req.headers['referer'];
  if (typeof referer === 'string' && referer.length > 0) return matches(referer);

  return false;
};
