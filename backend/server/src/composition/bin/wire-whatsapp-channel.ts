/** D-192 CORE #6 make-live — the WhatsApp recipient-resolver leaf.
 *
 *  The one real per-vendor delta in the shared credential-resolution path: which
 *  `config_json` fields name the bound conversation, and what the transport wants
 *  them as.
 *
 *  ⚠ WhatsApp's conversation address is a PAIR, and this is the file that says so.
 *  A send needs BOTH the business phone-number id (it is the URL path segment) and
 *  the user's `wa_id` (it is the body's `to`). Slack's URL is fixed and Telegram's
 *  carries the token, so no vendor before this one needed a second value — and
 *  `OutboundMessage { recipient, text, token }` has no slot for one.
 *
 *  The alternative was widening `RemoteChannelCredential` + `OutboundMessage` +
 *  `OutboundPrompt` + `ClosePrompt` + the resolver signature with a `sender_ref`,
 *  for exactly one vendor. Instead: the ADDRESS is the pair. That is not a dodge —
 *  a WhatsApp conversation genuinely IS a number-pair, and every shared seam
 *  already treats a recipient as an OPAQUE vendor string (the credential resolver
 *  returns one, the binding gate compares one by string equality, the session id is
 *  keyed on one). So the pair composes cleanly and costs no shared edit.
 *
 *  The codec lives in `@recued/transport` and BOTH halves call it: this file
 *  encodes from config, the transport decodes to build the URL, and
 *  `parseConversationId` re-encodes from the inbound payload so the binding gate's
 *  string compare lines up. One definition — because a format drift here would
 *  fail the gate silently (fail-closed, but invisible: the turn is simply refused). */

import { encodeWhatsAppAddress, normalizeWaId } from '@recued/transport';

import type { RemoteChannelRecipientResolver } from './wire-remote-channel.js';

/** `config.phone_number_id` (the business number, from the Meta console) +
 *  `config.wa_id` (the WhatsApp user to talk to) → one opaque address.
 *
 *  Both are normalized to bare digits. The owner types a human phone number
 *  (`+1 (650) 555-1234`); the webhook's `messages[].from` is always bare digits
 *  (`16505551234`). Without normalizing BOTH sides through the same function, the
 *  binding gate compares a formatted number against a bare one, never matches, and
 *  refuses every inbound turn — fail-closed, but for a purely cosmetic reason, and
 *  with nothing on screen to explain why.
 *
 *  ⚠ `phone_number_id` is a Graph object ID, not a phone number — it is already
 *  digits and must NOT be reformatted as one. It is normalized only to strip
 *  whitespace a paste might carry. */
export const resolveWhatsAppRecipient: RemoteChannelRecipientResolver = (config) => {
  if (config === null) return null;

  const raw_pnid = config.phone_number_id;
  const phone_number_id =
    typeof raw_pnid === 'string'
      ? normalizeWaId(raw_pnid)
      : typeof raw_pnid === 'number' && Number.isFinite(raw_pnid)
        ? String(raw_pnid)
        : '';
  if (phone_number_id.length === 0) return null;

  const raw_wa = config.wa_id;
  const wa_id =
    typeof raw_wa === 'string'
      ? normalizeWaId(raw_wa)
      : typeof raw_wa === 'number' && Number.isFinite(raw_wa)
        ? String(raw_wa)
        : '';
  if (wa_id.length === 0) return null;

  return encodeWhatsAppAddress(phone_number_id, wa_id);
};
