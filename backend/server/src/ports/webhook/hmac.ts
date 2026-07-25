/** D-148 P6 § A.6 — HMAC verifier shared across webhook vendors.
 *
 *  Vendors sign inbound webhooks with HMAC-SHA256 using a shared
 *  secret; the verifier compares against the request body bytes in
 *  constant time. Different vendors prefix the canonical message
 *  differently (Slack: `v0:<ts>:<body>`; HubSpot: `<ts><body>`;
 *  Telegram: secret in a header — no HMAC); the substrate keeps the
 *  primitive vendor-agnostic and lets the per-vendor caller stitch
 *  the canonical message. */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compute the HMAC-SHA256 hex digest of `message` keyed by `secret`. */
export const hmacSha256Hex = (secret: string, message: string | Buffer): string => {
  const h = createHmac('sha256', secret);
  h.update(message);
  return h.digest('hex');
};

/** Constant-time equality on two hex digests of equal length. False
 *  on length mismatch (no need to leak how close the attacker got). */
export const constantTimeEqualHex = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  // node's `timingSafeEqual` requires equal-length buffers.
  let aBuf: Buffer;
  let bBuf: Buffer;
  try {
    aBuf = Buffer.from(a, 'hex');
    bBuf = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
};

/** Slack-shaped signature: `v0=<hmac(secret, "v0:<ts>:<body>")>`. The
 *  caller has already extracted `ts` from the
 *  `X-Slack-Request-Timestamp` header; this helper computes the
 *  expected signature and compares it against the supplied
 *  `X-Slack-Signature` header. */
export const verifySlackSignature = (args: {
  signing_secret: string;
  timestamp: string;
  body: Buffer;
  signature: string;
}): boolean => {
  if (!args.signature.startsWith('v0=')) return false;
  const expected = `v0=${hmacSha256Hex(args.signing_secret, `v0:${args.timestamp}:${args.body.toString('utf-8')}`)}`;
  if (expected.length !== args.signature.length) return false;
  // `timingSafeEqual` over the raw byte buffers preserves the
  // constant-time property even though we'd otherwise compare hex
  // strings of equal length.
  return timingSafeEqual(Buffer.from(expected), Buffer.from(args.signature));
};
