/** Paddle Billing notification signature parity boundary.
 *
 * Paddle signs `<literal ts>:<exact body bytes>` with the notification
 * destination's endpoint secret key. Decoding deliberately happens only after
 * an adapter has authenticated those bytes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PADDLE_SIGNATURE_HEADER = 'paddle-signature';
/** The default replay tolerance enforced by Paddle's official SDK helpers. */
export const PADDLE_WEBHOOK_TOLERANCE_SECONDS = 5;

const MAX_PADDLE_SIGNATURE_HEADER_BYTES = 8_192;
const MAX_PADDLE_H1_SIGNATURES = 16;
const PADDLE_ENDPOINT_SECRET_KEY_RE =
  /^pdl_ntfset_[A-Za-z0-9]{26}_[A-Za-z0-9]{32}$/;

interface ParsedPaddleSignature {
  timestamp: string;
  timestamp_seconds: number;
  h1_signatures: readonly Buffer[];
}

export const isValidPaddleEndpointSecretKey = (
  value: unknown,
): value is string => typeof value === 'string'
  && PADDLE_ENDPOINT_SECRET_KEY_RE.test(value);

/** Parse one canonical timestamp and one or more current `h1` signatures.
 * Unknown version keys remain ignorable for forward compatibility, while
 * duplicate timestamps and malformed key/value parts fail closed.
 */
const parsePaddleSignature = (
  header: string,
): ParsedPaddleSignature | null => {
  if (header.length === 0
    || Buffer.byteLength(header, 'utf8') > MAX_PADDLE_SIGNATURE_HEADER_BYTES) {
    return null;
  }
  let timestamp: string | null = null;
  const signatures: Buffer[] = [];
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (part.length === 0
      || separator <= 0
      || separator === part.length - 1
      || part.indexOf('=', separator + 1) !== -1) {
      return null;
    }
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!/^[A-Za-z0-9_]+$/.test(key)) return null;
    if (key === 'ts') {
      if (timestamp !== null || !/^[1-9][0-9]*$/.test(value)) return null;
      timestamp = value;
      continue;
    }
    if (key === 'h1') {
      if (signatures.length >= MAX_PADDLE_H1_SIGNATURES
        || !/^[0-9a-f]{64}$/.test(value)) {
        return null;
      }
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return null;
  return {
    timestamp,
    timestamp_seconds: timestampSeconds,
    h1_signatures: signatures,
  };
};

/** Verify one endpoint-secret candidate against the untouched request bytes. */
export const verifyPaddleWebhookSignature = (input: {
  header: string;
  raw_body: Buffer;
  endpoint_secret_key: string;
  now_ms: number;
}): boolean => {
  if (!isValidPaddleEndpointSecretKey(input.endpoint_secret_key)
    || !Number.isSafeInteger(input.now_ms)
    || input.now_ms < 0) {
    return false;
  }
  const parsed = parsePaddleSignature(input.header);
  if (parsed === null) return false;
  const currentSeconds = Math.floor(input.now_ms / 1_000);
  if (!Number.isSafeInteger(currentSeconds)
    || Math.abs(currentSeconds - parsed.timestamp_seconds)
      > PADDLE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac('sha256', input.endpoint_secret_key)
    .update(`${parsed.timestamp}:`)
    .update(input.raw_body)
    .digest();
  return parsed.h1_signatures.some((presented) => {
    try {
      return timingSafeEqual(expected, presented);
    } catch {
      return false;
    }
  });
};
