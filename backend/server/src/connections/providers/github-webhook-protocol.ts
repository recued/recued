/** GitHub webhook exact-byte authentication and shared bounded JSON boundary.
 *
 * GitHub signs only the original request body with HMAC-SHA256. Delivery,
 * event, and hook identifiers arrive in separate headers, so the D-201 profile
 * validates them independently without pretending the HMAC covers them.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_JSON_OBJECT_DECODER_V1 } from '../../webhook-json-object-decoder.js';

export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery';
export const GITHUB_EVENT_HEADER = 'x-github-event';
export const GITHUB_HOOK_ID_HEADER = 'x-github-hook-id';

export const MAX_GITHUB_WEBHOOK_SECRET_BYTES = 4_096;

const GITHUB_SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;

/** Protocol-level verifier input. GitHub permits arbitrary high-entropy text;
 * Recued-generated credential admission is a separate profile concern. */
export const isValidGitHubWebhookSecret = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= MAX_GITHUB_WEBHOOK_SECRET_BYTES;

/** Verify GitHub's literal `sha256=<lowercase hex>` header against untouched
 * request bytes. The fixed grammar gives timingSafeEqual equal-length inputs. */
export const verifyGitHubWebhookSignature = (input: {
  signature: string;
  raw_body: Buffer;
  webhook_secret: string;
}): boolean => {
  if (!isValidGitHubWebhookSecret(input.webhook_secret)) return false;
  const parsed = GITHUB_SIGNATURE_RE.exec(input.signature);
  if (parsed === null) return false;
  const presented = Buffer.from(parsed[1]!, 'hex');
  const expected = createHmac('sha256', input.webhook_secret)
    .update(input.raw_body)
    .digest();
  try {
    return timingSafeEqual(expected, presented);
  } catch {
    return false;
  }
};

/** Decode one authenticated JSON payload without assigning event semantics to
 * arbitrary body members. The profile event classification remains the
 * separately validated GitHub event header. */
export const decodeGitHubWebhookPayload = (
  rawBody: Buffer,
): Record<string, unknown> | null => WEBHOOK_JSON_OBJECT_DECODER_V1.decode(rawBody);
