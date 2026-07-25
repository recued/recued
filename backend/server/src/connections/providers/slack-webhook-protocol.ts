/** Shared Slack request-signing boundary.
 *
 * The legacy server-direct provider retains these checks. D-201 selects the
 * equivalent closed timestamped-HMAC mechanism through trusted preset data.
 * Signature verification always covers the untouched request bytes; D-201
 * decoding and normalization live in neutral profile engines.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_REPLAY_WINDOW_SECONDS = 60 * 5;
export const SLACK_REQUEST_TIMESTAMP_HEADER = 'x-slack-request-timestamp';
export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';

export const MAX_SLACK_SIGNING_SECRET_BYTES = 4_096;

const MAX_SLACK_TIMESTAMP_HEADER_BYTES = 32;

interface ParsedSlackSignature {
  timestamp_literal: string;
  timestamp_seconds: number;
  signature: Buffer;
}

export const isValidSlackSigningSecret = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= MAX_SLACK_SIGNING_SECRET_BYTES;

const parseSlackSignature = (
  timestamp: string,
  signature: string,
): ParsedSlackSignature | null => {
  if (Buffer.byteLength(timestamp, 'utf8') > MAX_SLACK_TIMESTAMP_HEADER_BYTES
    || !/^[0-9]+$/.test(timestamp)
    || !/^v0=[0-9a-f]{64}$/.test(signature)) {
    return null;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return null;
  return {
    timestamp_literal: timestamp,
    timestamp_seconds: timestampSeconds,
    signature: Buffer.from(signature.slice(3), 'hex'),
  };
};

/** Verify one signing-secret candidate against Slack's literal timestamp and
 * exact raw request bytes. Leading-zero timestamps remain signature-stable;
 * non-decimal suffixes and unsafe integers fail closed.
 */
export const verifySlackWebhookSignature = (input: {
  timestamp: string;
  signature: string;
  raw_body: Buffer;
  signing_secret: string;
  now_ms: number;
}): boolean => {
  if (!isValidSlackSigningSecret(input.signing_secret)
    || !Number.isSafeInteger(input.now_ms)
    || input.now_ms < 0) {
    return false;
  }
  const parsed = parseSlackSignature(input.timestamp, input.signature);
  if (parsed === null) return false;
  const currentSeconds = Math.floor(input.now_ms / 1_000);
  if (!Number.isSafeInteger(currentSeconds)
    || Math.abs(currentSeconds - parsed.timestamp_seconds)
      > SLACK_REPLAY_WINDOW_SECONDS) {
    return false;
  }
  const expected = createHmac('sha256', input.signing_secret)
    .update(`v0:${parsed.timestamp_literal}:`)
    .update(input.raw_body)
    .digest();
  try {
    return timingSafeEqual(expected, parsed.signature);
  } catch {
    return false;
  }
};
