/** D-192 CORE #6 make-live — WhatsApp (Meta) inbound webhook protocol.
 *
 *  Two independent checks, for two independent Meta requirements:
 *
 *  1. **Delivery signature** — Meta signs the RAW request body with the App
 *     Secret and presents `X-Hub-Signature-256: sha256=<hex>`. Same shared-secret
 *     HMAC family as Slack, with one consequential difference: Slack's base string
 *     is `v0:<timestamp>:<body>`, and that timestamp is what gives Slack a replay
 *     WINDOW. Meta signs the body alone. There is no timestamp to bound a replay
 *     with, so this file deliberately has no window — the port's idempotency
 *     ledger is the replay defence, and it is exact for Meta because a retry is a
 *     byte-identical redelivery (the port's body-hash dedup key catches it).
 *
 *  2. **Endpoint handshake** — Meta will not deliver a single POST until the
 *     endpoint proves ownership on a GET: `?hub.mode=subscribe&hub.verify_token=…
 *     &hub.challenge=…`, answered by echoing the raw challenge as `text/plain`.
 *     This is not optional and not a nicety; it is how a subscription is created
 *     at all.
 *
 *  Both compares are constant-time over fixed-length digests.
 */

import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** The delivery-signature header. */
export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Meta's signature grammar: `sha256=` + 64 lowercase hex. Anything else is
 *  refused before any crypto runs — a malformed header can never be made to
 *  match, and rejecting on grammar keeps `timingSafeEqual` off ragged input. */
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

/** Bound the secret the same way the Slack/Telegram protocols bound theirs — a
 *  missing or absurd secret is a misconfiguration, and must fail closed rather
 *  than key an HMAC with garbage. */
const MAX_SECRET_BYTES = 4096;

export const isValidWhatsAppAppSecret = (secret: unknown): secret is string =>
  typeof secret === 'string'
  && secret.length > 0
  && Buffer.byteLength(secret, 'utf8') <= MAX_SECRET_BYTES;

/** Verify `X-Hub-Signature-256` over the EXACT request bytes.
 *
 *  ⚠ The raw buffer, never a re-serialized string. Meta escapes non-ASCII as
 *  `\uXXXX` when it signs, so a JSON round-trip (`JSON.stringify(JSON.parse(b))`)
 *  produces different bytes for any payload carrying an emoji or an accent — and
 *  a WhatsApp message is exactly the place those show up. Re-serializing would
 *  reject real traffic from real users while passing every ASCII test fixture.
 *  The D-148 port hands the raw `Buffer` in, before any parse. */
export const verifyWhatsAppSignature = (input: {
  raw_body: Buffer;
  signature_header: string | undefined;
  app_secret: string;
}): boolean => {
  if (!isValidWhatsAppAppSecret(input.app_secret)) return false;
  if (typeof input.signature_header !== 'string') return false;
  const matched = SIGNATURE_PATTERN.exec(input.signature_header.trim());
  if (matched === null) return false;
  const presented = Buffer.from(matched[1]!, 'hex');
  const expected = createHmac('sha256', input.app_secret)
    .update(input.raw_body)
    .digest();
  try {
    return timingSafeEqual(expected, presented);
  } catch {
    return false;
  }
};

/** The GET handshake result — the raw response the port must write back. */
export interface WhatsAppChallengeResult {
  status: number;
  body: string;
  content_type: string;
}

/** Meta's verify-token grammar. The owner types the same string here and into the
 *  Meta console, so keep it to what both sides handle unambiguously. */
const VERIFY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export const isValidWhatsAppVerifyToken = (token: unknown): token is string =>
  typeof token === 'string' && VERIFY_TOKEN_PATTERN.test(token);

/** Constant-time compare over sha256 digests — the presented and expected tokens
 *  may differ in LENGTH, and `timingSafeEqual` throws on unequal lengths (and
 *  would otherwise leak the length). Hashing both to a fixed 32 bytes first is the
 *  same trick the Telegram secret-token compare uses. */
const digestForCompare = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/** Answer Meta's subscription handshake.
 *
 *  Returns `null` for ANY failure — wrong mode, absent/ill-formed/mismatched
 *  token, missing challenge. The port turns a `null` into the same generic 404 an
 *  unwired path returns, which is what keeps this from widening the port's
 *  fingerprint: without the verify token, a GET cannot tell a live WhatsApp
 *  connection from a path that was never configured.
 *
 *  The challenge is echoed VERBATIM as `text/plain`. Meta compares the body byte
 *  for byte — a JSON-wrapped or pretty-printed echo fails the subscription, which
 *  is a confusing failure to debug because nothing else about the endpoint looks
 *  wrong. */
export const answerWhatsAppChallenge = (input: {
  query: URLSearchParams;
  verify_token: string;
}): WhatsAppChallengeResult | null => {
  if (!isValidWhatsAppVerifyToken(input.verify_token)) return null;
  if (input.query.get('hub.mode') !== 'subscribe') return null;
  const presented = input.query.get('hub.verify_token');
  if (!isValidWhatsAppVerifyToken(presented)) return null;
  if (!timingSafeEqual(digestForCompare(presented), digestForCompare(input.verify_token))) {
    return null;
  }
  const challenge = input.query.get('hub.challenge');
  if (typeof challenge !== 'string' || challenge.length === 0) return null;
  return { status: 200, body: challenge, content_type: 'text/plain; charset=utf-8' };
};
