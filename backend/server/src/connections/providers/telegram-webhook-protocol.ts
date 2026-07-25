/** Shared Telegram Bot API webhook authentication and endpoint boundary.
 *
 * The legacy server-direct provider and D-201 durable profile both use the
 * exact secret-token checks and hosted Bot API endpoint restrictions. D-201
 * delivery semantics are selected separately through neutral profile engines.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { isTelegramSupportedPort } from '@recued/contracts';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
export const MAX_TELEGRAM_WEBHOOK_SECRET_CHARACTERS = 256;
const TELEGRAM_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

export const isValidTelegramWebhookSecret = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= MAX_TELEGRAM_WEBHOOK_SECRET_CHARACTERS
  && TELEGRAM_SECRET_RE.test(value);

/** Telegram's hosted Bot API accepts outgoing HTTPS webhooks only on its
 * documented port set. This validates the external canonical URL, not the
 * paired server's internal listener port behind a reverse proxy.
 */
export const isTelegramWebhookEndpointSupported = (value: unknown): value is string => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:'
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0) {
      return false;
    }
    const port = parsed.port === '' ? 443 : Number(parsed.port);
    return Number.isSafeInteger(port) && isTelegramSupportedPort(port);
  } catch {
    return false;
  }
};

const digestForCompare = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/** Compare one presented Telegram header with one configured secret without a
 * length-dependent digest comparison. Both sides must obey setWebhook's closed
 * ASCII token grammar.
 */
export const verifyTelegramWebhookSecret = (input: {
  presented: string;
  expected: string;
}): boolean => {
  if (!isValidTelegramWebhookSecret(input.presented)
    || !isValidTelegramWebhookSecret(input.expected)) {
    return false;
  }
  return timingSafeEqual(
    digestForCompare(input.presented),
    digestForCompare(input.expected),
  );
};
