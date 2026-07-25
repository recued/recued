/** Legacy Stripe classic-event webhook protocol/parity boundary.
 *
 * The D-196 vendor descriptor still uses this transport and event helper. The
 * D-201 durable adapter independently composes closed mechanism, decoder,
 * normalizer, and projector presets; this module remains its behavior-parity
 * fixture until the legacy route is retired.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookJsonObjectDecoder } from '../../webhook-json-object-decoder.js';

/** Stripe's documented default tolerance for timestamped webhook signatures. */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 60 * 5;

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export const MAX_STRIPE_ENDPOINT_SECRET_BYTES = 4_096;
export const MAX_STRIPE_EVENT_ID_BYTES = 512;
export const MAX_STRIPE_EVENT_TYPE_BYTES = 128;

const MAX_STRIPE_SIGNATURE_HEADER_BYTES = 8_192;
const MAX_STRIPE_V1_SIGNATURES = 16;
const STRIPE_ENDPOINT_SECRET_RE = /^whsec_[A-Za-z0-9_-]+$/;
const STRIPE_EVENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

interface ParsedStripeSignature {
  timestamp: string;
  timestamp_seconds: number;
  v1_signatures: readonly Buffer[];
}

export interface DecodedStripeWebhookEvent {
  event_id: string;
  type: string;
  created: number;
  livemode: boolean;
  resource_id: string | null;
  payload: Record<string, unknown>;
}

export const isValidStripeEndpointSecret = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= MAX_STRIPE_ENDPOINT_SECRET_BYTES
  && STRIPE_ENDPOINT_SECRET_RE.test(value);

/** Parse only the signed timestamp and current (`v1`) signature scheme.
 *
 * Unknown schemes are ignored so Stripe may include legacy/future entries.
 * Multiple `v1` values are expected during endpoint-secret rotation. Multiple
 * timestamp values are accepted only when identical; divergent timestamps
 * make the canonical signed payload ambiguous and fail closed.
 */
const parseStripeSignature = (header: string): ParsedStripeSignature | null => {
  if (Buffer.byteLength(header, 'utf8') > MAX_STRIPE_SIGNATURE_HEADER_BYTES) {
    return null;
  }
  let timestamp: string | null = null;
  const v1Signatures: Buffer[] = [];

  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator <= 0) continue;

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === 't') {
      // Keep the lexical value for HMAC canonicalization, but require its
      // canonical decimal form so parse/stringify ambiguity (leading zeros,
      // signs, exponent notation, whitespace) cannot produce two meanings.
      if (!/^[1-9][0-9]*$/.test(value)) return null;
      if (timestamp !== null && timestamp !== value) return null;
      timestamp = value;
      continue;
    }
    if (key === 'v1') {
      if (v1Signatures.length >= MAX_STRIPE_V1_SIGNATURES
        || !/^[0-9a-fA-F]{64}$/.test(value)) {
        return null;
      }
      v1Signatures.push(Buffer.from(value, 'hex'));
    }
  }

  if (timestamp === null || v1Signatures.length === 0) return null;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return null;

  return {
    timestamp,
    timestamp_seconds: timestampSeconds,
    v1_signatures: v1Signatures,
  };
};

/** Verify one endpoint-secret candidate against exact request bytes. */
export const verifyStripeWebhookSignature = (input: {
  header: string;
  raw_body: Buffer;
  endpoint_secret: string;
  now_ms: number;
}): boolean => {
  if (!isValidStripeEndpointSecret(input.endpoint_secret)
    || !Number.isSafeInteger(input.now_ms)
    || input.now_ms < 0) {
    return false;
  }
  const parsed = parseStripeSignature(input.header);
  if (parsed === null) return false;

  const currentSeconds = Math.floor(input.now_ms / 1_000);
  if (!Number.isSafeInteger(currentSeconds)
    || Math.abs(currentSeconds - parsed.timestamp_seconds)
      > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  // The body must stay byte-for-byte identical to Stripe's delivery. JSON
  // decoding or reserialization before this point would change whitespace,
  // key order, escape forms, or invalid UTF-8 handling and break the HMAC.
  const expected = createHmac('sha256', input.endpoint_secret)
    .update(`${parsed.timestamp}.`)
    .update(input.raw_body)
    .digest();
  return parsed.v1_signatures.some((candidate) => {
    try {
      return timingSafeEqual(expected, candidate);
    } catch {
      return false;
    }
  });
};

const boundedNonBlankString = (
  value: unknown,
  maxBytes: number,
): value is string => typeof value === 'string'
  && value.trim() === value
  && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

const optionalResourceId = (payload: Record<string, unknown>): string | null => {
  const data = payload.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const object = (data as Record<string, unknown>).object;
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return null;
  const id = (object as Record<string, unknown>).id;
  return boundedNonBlankString(id, MAX_STRIPE_EVENT_ID_BYTES) ? id : null;
};

/** Decode only classic Stripe API-v1 event snapshots after authentication.
 * Thin API-v2 notifications use a different fetch/parse contract and stay
 * unsupported until a separately registered profile exists. The caller owns
 * bounded JSON decoding so the legacy D-196 transport can inject the same
 * closed engine selected by the generalized D-201 profile.
 */
export const decodeStripeWebhookEvent = (
  rawBody: Buffer,
  decoder: WebhookJsonObjectDecoder,
): DecodedStripeWebhookEvent | null => {
  const envelope = decoder.decode(rawBody);
  if (envelope === null
    || envelope.object !== 'event'
    || !boundedNonBlankString(envelope.id, MAX_STRIPE_EVENT_ID_BYTES)
    || !boundedNonBlankString(envelope.type, MAX_STRIPE_EVENT_TYPE_BYTES)
    || !STRIPE_EVENT_TYPE_RE.test(envelope.type)
    || typeof envelope.created !== 'number'
    || !Number.isSafeInteger(envelope.created)
    || envelope.created < 0
    || envelope.created > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
    || typeof envelope.livemode !== 'boolean') {
    return null;
  }

  return {
    event_id: envelope.id,
    type: envelope.type,
    created: envelope.created,
    livemode: envelope.livemode,
    resource_id: optionalResourceId(envelope),
    payload: envelope,
  };
};
