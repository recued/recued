/** D-149 P3 § A.18 + § Must Hold I-10 — Reception bearer-secret +
 *  endpoint_id primitives.
 *
 *  Two surfaces:
 *
 *    1. `endpoint_id` (also = `public_locator`) — opaque uuid; 16 bytes
 *       random base64url. Used as the URL-path component AND the
 *       `public_endpoint_registry` primary key. Safe to log; safe to
 *       embed in URLs. Generated at `endpoint.create` rpc.
 *
 *    2. `bearer_secret` — 32-byte random base64url; 256 bits of
 *       entropy. Returned to the caller ONCE in the create response;
 *       the substrate stores only `HMAC-SHA256(server_secret_pepper,
 *       bearer_secret)`. Verify path: per-IP rate-limit check FIRST →
 *       compute HMAC of submitted secret → constant-time compare.
 *
 *  `single_use_secret` (approval_link only) uses the same generator +
 *  same HMAC storage discipline; the additional invariant is the
 *  `consumed_at` flip on first valid presentation per Must Hold I-11.
 *
 *  **No Argon2id at the request path.** Random 256-bit secrets do not
 *  benefit from password-hashing's slow-by-design property; per-request
 *  Argon2id verify is a DoS lever (an attacker forces the server to do
 *  expensive work). HMAC-SHA256 with constant-time compare is the
 *  standard for random API tokens (cf. Stripe / GitHub PATs / AWS
 *  signature). § A.18.2 elaborates; § Must Hold I-10 enforces.
 *
 *  Spec: D-149 § A.18.1 + § A.18.2 + § Must Hold I-10. */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { computeBearerHmac } from './server-secret-pepper.js';

/** § A.18.1 — opaque endpoint_id byte length. 16 bytes ⇒ 128 bits of
 *  entropy ⇒ collision-resistant under the birthday bound for any
 *  reasonable number of endpoints. base64url-encoded the wire shape is
 *  22 characters; URL-safe and Authorization-header-safe. */
export const ENDPOINT_ID_BYTE_LENGTH = 16;

/** § A.18.1 — bearer_secret byte length. 32 bytes ⇒ 256 bits ⇒ matches
 *  the HMAC-SHA256 output size; safely uniformly random. base64url
 *  encoded the wire shape is 43 characters. */
export const BEARER_SECRET_BYTE_LENGTH = 32;

/** Generate an opaque endpoint_id. base64url so it's URL-path-safe
 *  without further escaping. Asserts the random source returned the
 *  expected byte count — defense against partial-random sources. */
export const generateEndpointId = (): string => {
  const raw = randomBytes(ENDPOINT_ID_BYTE_LENGTH);
  if (raw.length !== ENDPOINT_ID_BYTE_LENGTH) {
    throw new Error(
      `generateEndpointId: random source returned ${raw.length} bytes; expected ${ENDPOINT_ID_BYTE_LENGTH}`,
    );
  }
  return raw.toString('base64url');
};

/** § A.18.1 — generate a 256-bit bearer_secret. Returned ONCE to the
 *  caller. base64url so it's URL-shareable + Authorization-header-safe.
 *  Asserts the random source returned the expected byte count. */
export const generateBearerSecret = (): string => {
  const raw = randomBytes(BEARER_SECRET_BYTE_LENGTH);
  if (raw.length !== BEARER_SECRET_BYTE_LENGTH) {
    throw new Error(
      `generateBearerSecret: random source returned ${raw.length} bytes; expected ${BEARER_SECRET_BYTE_LENGTH}`,
    );
  }
  return raw.toString('base64url');
};

/** § A.18.1 + § Must Hold I-10 — constant-time verify of a submitted
 *  bearer secret against the stored HMAC. Returns `true` iff the HMAC
 *  of the submitted secret (computed under the same pepper) matches
 *  the stored HMAC byte-for-byte. */
export const verifyBearerSecret = (input: {
  readonly submitted_secret: string;
  readonly stored_hmac: Buffer;
  readonly pepper: Buffer;
}): boolean => {
  // ⚠ THESE REJECT SILENTLY, AND THAT IS THE RIGHT CHOICE — the comment here
  // used to claim the opposite ("surface a clear error … we fail-loud at the
  // boundary … not a silent reject") while both branches return false. On an
  // UNAUTHENTICATED endpoint a throw is the worse answer: it is a distinguishable
  // response, so it hands an attacker exactly the behavioural probe the old
  // sentence said it was preventing, and an uncaught one is a 500 on a public
  // path. Everything else on this surface renders one identical failure page for
  // every reason; this matches it.
  //
  // 🔑 The second check is also load-bearing, not hygiene: `timingSafeEqual`
  // THROWS on unequal lengths, so a short/corrupt stored hash would become an
  // exception rather than a miss. It is what makes the 32-byte precondition
  // below true at the call, not just at row write.
  if (typeof input.submitted_secret !== 'string' || input.submitted_secret.length === 0) {
    return false;
  }
  if (!Buffer.isBuffer(input.stored_hmac) || input.stored_hmac.length !== 32) {
    return false;
  }
  const computed = computeBearerHmac(input.submitted_secret, input.pepper);
  // `timingSafeEqual` requires equal-length buffers; computeBearerHmac
  // always returns 32 bytes, and the stored hash is 32 bytes by I-10
  // assertion at row write.
  return timingSafeEqual(computed, input.stored_hmac);
};

/** Build the per-kind share URL for a freshly-created endpoint.
 *  Returned ONCE alongside `bearer_secret_once`; not persisted server-
 *  side (the registry stores only the HMAC). Reception clients
 *  reconstruct the URL on subsequent shares via `rotate_token`. */
export const buildShareUrl = (input: {
  readonly base_url: string;
  readonly kind:
    | 'reception_page'
    | 'scheduling_link'
    | 'intake_form'
    | 'drop_link'
    | 'approval_link'
    | 'status_link';
  readonly endpoint_id: string;
  readonly bearer_secret: string;
}): string => {
  const base = input.base_url.replace(/\/+$/, '');
  switch (input.kind) {
    case 'reception_page':
      return `${base}/reception/?t=${encodeURIComponent(input.bearer_secret)}`;
    case 'scheduling_link':
      return `${base}/reception/scheduling/${encodeURIComponent(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}`;
    case 'intake_form':
      return `${base}/reception/intake/${encodeURIComponent(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}`;
    case 'drop_link':
      return `${base}/reception/drop/${encodeURIComponent(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}`;
    case 'approval_link':
      // Codex review P1 fold (2026-05-13) — the spec's "single_use_secret
      // out-of-band via mail" pattern (§ A.18.3 line 1465) layers a
      // SECOND secret on top of the substrate's bearer model, but
      // D-149 P8 ships only the bearer + the `consumed_at` single-use
      // flip. Without the bearer in the URL the dispatcher's
      // universal token check rejects tokenless requests with 401
      // (visitor never reaches the prompt render). The bearer-in-URL
      // pattern matches the four other link-style kinds; the soft-
      // trust "URL leak doesn't grant action authority" envelope is
      // preserved by the single-use enforcement (consumed_at flip +
      // 410 Gone on re-use) + `require_email_match` constraint. A
      // future phase can extend the substrate with a separate
      // `single_use_secret_hmac` column on `reception_approval_intent`
      // + form-field paste flow for higher-assurance approvals.
      return `${base}/reception/approve/${encodeURIComponent(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}`;
    case 'status_link':
      return `${base}/reception/status/${encodeURIComponent(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}`;
  }
};
