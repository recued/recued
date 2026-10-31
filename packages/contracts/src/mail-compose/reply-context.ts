/** D-145 PA7 — reply-context derivation.
 *
 *  Pure: given a `MailReplyContext`, return a `Partial<MailComposeValues>`
 *  shape with `in_reply_to` / `to` / `subject` / `sender_source`
 *  prepopulated. Other fields (cc / bcc / body / attachments) are left
 *  untouched — the user composes those.
 *
 *  Spec: D-145 § A.5.4 (Reply-context handling). */

import type { MailComposeValues, MailReplyContext } from './types.js';
import { parseAddress } from '../contact.js';
import { mailRecipientInvalidReason } from '../mail.js';

const RE_PREFIX = /^re:\s/i;

/** Add `Re: ` to a subject unless it already has a Re-style prefix
 *  (case-insensitive — `re: ` / `Re: ` / `RE: ` all count). RFC 5322
 *  doesn't pin a canonical reply-prefix; mainstream clients converge
 *  on `Re:` (single-instance, no count suffix). The substrate matches
 *  that convention.
 *
 *  Empty / whitespace-only subjects yield `Re: ` — the user edits
 *  before send. */
export const addReReplyPrefix = (subject: string): string => {
  if (RE_PREFIX.test(subject)) return subject;
  return `Re: ${subject}`;
};

/** Pure: derive the prepopulated values for a reply-mode compose. */
export const deriveReplyValues = (
  context: MailReplyContext,
): Pick<MailComposeValues, 'to' | 'subject' | 'in_reply_to' | 'sender_source' | 'references'> => ({
  to: [...(context.original_message.reply_to?.length ? context.original_message.reply_to : [context.original_message.from])],
  subject: addReReplyPrefix(context.original_message.subject),
  in_reply_to: context.original_message.id,
  sender_source: context.original_source_id,
  references: [...new Set([...(context.original_message.references ?? []), context.original_message.id])],
});

/** Reply all uses only verified, individually valid addresses. Unknown or
 * incomplete metadata never becomes a guessed recipient list. */
export const deriveReplyAllValues = (
  context: MailReplyContext,
): (ReturnType<typeof deriveReplyValues> & Pick<MailComposeValues, 'cc' | 'bcc'>) | null => {
  const email = (value: unknown): string | null => {
    if (typeof value !== 'string' || mailRecipientInvalidReason(value) !== null) return null;
    const address = parseAddress(value)?.email;
    // Removing a display-name wrapper must not expose a second address list.
    return address && mailRecipientInvalidReason(address) === null ? address : null;
  };
  const self = email(context.mailbox_address);
  const original = context.original_message;
  if (!self || !Array.isArray(original.to) || !Array.isArray(original.cc)) return null;
  const reply = deriveReplyValues(context);
  const primary = reply.to.map(email);
  if (!primary.length || primary.some(address => address === null || address === self)) return null;
  const seen = new Set([self]);
  const to: string[] = [], cc: string[] = [];
  for (const [addresses, output] of [[reply.to, to], [original.to, to], [original.cc, cc]] as const) {
    for (const value of addresses) {
      const address = email(value);
      if (!address) return null;
      if (!seen.has(address)) { seen.add(address); output.push(address); }
    }
  }
  // A second action is useful only when it includes someone Reply would omit.
  const normal = new Set(primary);
  if (![...to, ...cc].some(address => !normal.has(address))) return null;
  return { ...reply, to, cc, bcc: [] };
};
