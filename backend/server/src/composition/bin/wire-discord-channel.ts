/** D-192 — the Discord recipient-resolver leaf.
 *
 *  The simplest of the four, and worth saying why: Discord's channel id IS both the
 *  send URL's path segment (`/channels/{id}/messages`) AND the bound conversation
 *  the binding gate compares against. One value, one field — no pair (contrast
 *  WhatsApp, whose send URL is account-scoped and therefore needs both halves).
 *
 *  A snowflake is a numeric string. Accept it typed either way: a user pasting an id
 *  out of Discord's "Copy ID" gets a string, but a hand-written config JSON may well
 *  carry it unquoted, and refusing that would be a gratuitous way to fail. */

import type { RemoteChannelRecipientResolver } from './wire-remote-channel.js';

/** `config.channel_id` — a non-empty string, or a finite number coerced to one.
 *  ⚠ Coerce with care: a Discord snowflake is a 64-bit id and JSON numbers are
 *  doubles, so a large one CANNOT survive `JSON.parse` intact. `Number.isSafeInteger`
 *  is the guard — an unquoted id past 2^53 is REFUSED rather than silently rounded
 *  into a different channel's id, which would deliver an approval to the wrong place.
 *  Quote it and it round-trips exactly, which is why the string path is first. */
export const resolveDiscordRecipient: RemoteChannelRecipientResolver = (config) => {
  if (config === null) return null;
  const raw = config.channel_id;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return /^[0-9]+$/.test(trimmed) ? trimmed : null;
  }
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return String(raw);
  }
  return null;
};
